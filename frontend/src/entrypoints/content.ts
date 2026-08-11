/**
 * Content script: extracts candidates, runs local rules, tracks timer
 * cadence, sends new candidates to background.ts for classification, and
 * renders the overlay with the merged results. See docs/ARCHITECTURE.md 4.1
 * and frontend/README.md.
 */
import { extractCandidatesWithElements } from "../lib/extract/extract";
import { proposeGroups, type ProposedGroup } from "../lib/extract/group";
import { runRules } from "../lib/rules";
import type { Lang } from "../lib/taxonomy";
import type {
  CandidateWithHits,
  ClassifyItemResult,
  ClassifyProgressMessage,
  ClassifyResultMessage,
  ContextReply,
  ExportTraceMessage,
  GetContextMessage,
  ScrollToMessage,
  StoredFindings,
  UploadTraceNowMessage,
  UploadTraceReply,
} from "../lib/messaging";
import { MAX_CONTEXT_CHARS, MAX_CONTEXT_SNIPPETS } from "../lib/api/explain";
import { findingsStorageKey, stripFragment } from "../lib/messaging";
import { recordObservation, isAnimated } from "../lib/timer-tracker";
import { mountOverlay, scrollAndHighlight } from "../ui/overlay";
import { resolveOccurrence, type ResolveDiagnostic } from "../lib/resolve";
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from "../lib/settings";

const DEBOUNCE_MS = 300;

/** Hard floor between two full extraction passes. The 300ms debounce only
 * limits how soon a pass runs after the *last* mutation -- on a page that
 * mutates continuously (ad carousels, live counters, lazy-loading grids)
 * mutations never stop arriving, so the debounce alone still lets extraction
 * run several times a second forever. */
const MIN_EXTRACTION_INTERVAL_MS = 1000;

/**
 * Dedupe key that survives a counter ticking.
 *
 * `candidate.id` is occurrenceId(lang, text, selector) as of Fix 1 (still
 * text-sensitive), so a countdown timer, a stock counter and a "N people are
 * viewing this" line all mint a brand-new id on every tick even though their
 * selector hasn't moved. Nothing then matches `sentIds`, and the page
 * re-classifies that snippet once a second for as long as the tab is open --
 * visible on Daraz as an endless run of "extracted 130 candidates, 1 new" in
 * the console.
 *
 * Masking digit runs collapses "Only 3 left" / "Only 2 left" and
 * "02:14:59" / "02:14:58" onto one key per element. That is the right
 * granularity for this project: the finding is the *pattern* (scarcity,
 * urgency), which does not change when the number does. The selector stays in
 * the key so two different elements are never collapsed into each other.
 */
function churnKeyFor(candidate: { selector: string; text: string }): string {
  return `${candidate.selector}|${candidate.text.replace(/\d+/g, "#")}`;
}

/**
 * One row of the full extraction -> classification trace (see `trace` in
 * main() and window.__dpTrace / window.__dpExportTrace()). Built to answer
 * exactly one question without guessing: for this specific piece of text,
 * what actually happened -- was it extracted, sent, and what did the model
 * and local rules decide?
 */
interface TraceEntry {
  id: string;
  text: string;
  tag: string;
  role: string;
  /** Which part of a product listing this is (fields.ts). The single most
   * useful column when reading a trace back: it says whether a rule fired on
   * a badge or on a seller's title copy. */
  field: string;
  /** Id of the semantic group this fragment was proposed as part of, if any
   * (lib/extract/group.ts). **Shadow mode**: this records what grouping
   * *would* do. Nothing in the pipeline reads it -- the fragment was still
   * classified on its own. */
  groupId?: string;
  step: string | null;
  selector: string;
  /** Local rule names that fired for this candidate (independent of the
   * model -- see rules/index.ts). */
  ruleHits: string[];
  sentToModel: boolean;
  /** Model findings a merge policy refused, with the reason. Empty or absent
   * means nothing was suppressed -- which is what makes `findingLabels: []`
   * readable as "the model found nothing" rather than "something was hidden". */
  withheld?: Array<{ label: string; reason: string }>;
  /** null = no classify response has been observed for this id yet.
   * [] = confirmed benign (sent, and absent from every subsequent
   * response -- see the sendMessage handler in runExtraction for exactly
   * how that's inferred). Non-empty = the finding labels present. */
  findingLabels: string[] | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

function detectPageLang(): Lang {
  const htmlLang = document.documentElement.lang?.slice(0, 2).toLowerCase();
  if (htmlLang === "hi" || htmlLang === "ne") return htmlLang;
  return "en";
}

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    const lang = detectPageLang();
    // Live element registry, keyed by candidate.id -- as of Fix 1, an
    // *occurrence* id (hash.ts's occurrenceId: lang+selector+text), not a
    // text-only hash. Each distinct DOM occurrence of the same string (three
    // separate "Add to Cart" buttons, say) therefore gets its own registry
    // entry pointing at its own element, instead of all three overwriting
    // one shared slot. Refreshed on every extraction pass. This is what lets
    // the overlay find the right node even after a framework re-render has
    // invalidated a positionally-computed selector -- see ui/overlay.ts's
    // resolveElement doc comment. Elements for ids no longer present on the
    // page are left in place rather than pruned; overlay.ts checks
    // `el.isConnected` before using one, so a stale entry just gets skipped,
    // not resurrected.
    const elementRegistry = new Map<string, Element>();

    /**
     * Ids we failed to re-locate since the last extraction pass. Without this,
     * every unresolvable item would trigger a full-document text scan on every
     * scroll frame. Cleared at the start of each extraction pass, because that
     * is the only moment new nodes can have appeared.
     */
    const unresolvable = new Set<string>();

    /**
     * Prediction -> DOM resolution, delegated to lib/resolve.ts (Fix 2). See
     * that module's doc comment for the three-tier strategy and why it
     * refuses to guess on ambiguous or already-claimed matches.
     *
     * `unresolvable` is a same-pass negative cache: overlay.ts's render() can
     * run many times per extraction pass (once per scroll/resize/mutation),
     * and resolve.ts's tier-3 structural scan is the expensive one -- without
     * this, every still-unresolved item would re-pay for that scan on every
     * render, not just once per extraction pass.
     */
    function resolveForItem(item: ClassifyItemResult): Element | null {
      if (unresolvable.has(item.id)) return null;

      const resolved = resolveOccurrence(item, elementRegistry, {
        onDiagnostic: recordResolveDiagnostic,
      });
      if (!resolved) unresolvable.add(item.id);
      return resolved;
    }

    const overlay = mountOverlay(resolveForItem);

    /**
     * Local mirror of the user's settings, kept current by the subscription
     * below. Held synchronously (rather than awaited at each use) because the
     * hot paths that read it -- the extraction gate, the overlay's visibility
     * -- run on every mutation, and an await per mutation would put a storage
     * round trip in the middle of the observer loop.
     *
     * Starts at DEFAULT_SETTINGS (everything on) rather than blocking on the
     * first read: the initial extraction is debounced by ~300ms, which the
     * load below comfortably wins, and defaulting to "on" means a storage
     * failure degrades to the extension working rather than silently doing
     * nothing.
     */
    let settings: Settings = { ...DEFAULT_SETTINGS };

    function applySettings(next: Settings): void {
      const wasScanning = settings.scanEnabled;
      settings = next;
      overlay.setVisible(next.overlayVisible);
      // Scanning just came back on. Mutations that arrived while it was off
      // were dropped rather than queued, so without kicking a pass here the
      // page would stay unscanned until it next happened to mutate -- on a
      // static product page, potentially never.
      if (!wasScanning && next.scanEnabled) scheduleExtraction();
    }

    void loadSettings().then(applySettings);
    onSettingsChanged(applySettings);
    // Ids already sent to background this session -- avoid resending a
    // candidate the backend has already resolved (docs/ARCHITECTURE.md 4.1,
    // "Hash and dedupe"). The background worker also dedupes independently
    // (its cache survives worker restarts, this doesn't need to), but
    // skipping the resend here saves the message-passing round trip too.
    const sentIds = new Set<string>();
    /** Same purpose as `sentIds`, but keyed so a ticking counter maps onto one
     * entry instead of a fresh one per tick -- see churnKeyFor. */
    const sentChurnKeys = new Set<string>();

    // Full extraction -> classification join, for auditing "why does this
    // exact text have no badge" without guessing. Every candidate this page
    // has ever extracted gets one entry here, updated in place as its fate
    // becomes known -- this is the join `window.__dpLastPairs` and
    // `window.__dpRenderDebug` couldn't give on their own, since neither one
    // alone says whether a *specific* candidate was ever sent, and if so,
    // what the model/rules actually decided for it. See `trace` below and
    // its exposure as window.__dpTrace / window.__dpExportTrace() near the
    // bottom of this file.
    const trace = new Map<string, TraceEntry>();
    /** Proposed semantic groups, and the group each candidate belongs to.
     * Written every extraction pass, read only by the debug trace. */
    const proposedGroups = new Map<string, ProposedGroup>();
    const groupIdByCandidate = new Map<string, string>();

    /**
     * Single funnel for every place a results list arrives (the direct
     * sendMessage response, background.ts's per-batch classify-progress
     * push, and the chrome.storage.onChanged fallback) -- updates `trace`
     * with what each item's findings actually are, then does what the three
     * call sites already did (overlay.update), then schedules the debounced
     * console table so the trace is visible without typing anything.
     */
    /**
     * The document this content script is currently showing, fragment
     * stripped.
     *
     * A content script is injected once per *document*, not once per
     * navigation. On an SPA -- which every storefront this targets is --
     * an in-page route change replaces the entire DOM but leaves this script,
     * and all of its accumulated state, exactly as it was. Nothing here used
     * to notice, so the previous route's candidates, sent-ids and badges
     * carried over onto the next page. That is why home-page findings kept
     * appearing on product pages.
     */
    let currentDocumentUrl = stripFragment(location.href);

    /** Drop every piece of per-page state and start over. Called when the
     * document URL changes under a still-running content script. */
    function resetForNewDocument(nextUrl: string): void {
      console.log(
        `[dark-pattern-analyzer] document changed -- resetting page state\n` +
          `  from: ${currentDocumentUrl}\n    to: ${nextUrl}`,
      );
      currentDocumentUrl = nextUrl;
      // A new document is a new scan: a fresh id so a capture taken here is
      // stored alongside the previous page's rather than overwriting it.
      scanId = crypto.randomUUID();
      latestPageScore = 0;
      elementRegistry.clear();
      unresolvable.clear();
      sentIds.clear();
      sentChurnKeys.clear();
      trace.clear();
      proposedGroups.clear();
      groupIdByCandidate.clear();
      // Clear the badges immediately rather than waiting for the first
      // classify response of the new page -- stale badges pointing at nodes
      // that no longer exist are worse than none.
      overlay.update([]);
    }

    /** True if the document changed since the last check; resets state if so. */
    function syncDocumentUrl(): boolean {
      const nextUrl = stripFragment(location.href);
      if (nextUrl === currentDocumentUrl) return false;
      resetForNewDocument(nextUrl);
      return true;
    }

    /**
     * Archive upload -- explicitly user-triggered only.
     *
     * This deliberately has no automatic path. An earlier version uploaded
     * every scan once it settled, behind a persistent opt-in setting; a button
     * is a better fit for what is being asked, because a trace contains real
     * text from the page in front of the user and a per-capture decision is a
     * far more meaningful consent than a toggle flipped once and forgotten.
     * Nothing here runs unless the user clicks.
     *
     * Uploads are idempotent by scan id, so pressing the button twice on the
     * same page replaces that capture rather than storing a near-duplicate.
     */
    /** Stable per document. Regenerated by resetForNewDocument so a capture
     * taken after an SPA route change is its own scan rather than overwriting
     * the previous page's. */
    let scanId = crypto.randomUUID();
    let latestPageScore = 0;

    async function uploadTrace(): Promise<{ ok: boolean; message: string }> {
      const entries = [...trace.values()];
      if (entries.length === 0) {
        return { ok: false, message: "Nothing extracted on this page yet." };
      }
      // http(s) only -- matches the backend's own validation, so a file:// or
      // chrome:// page gets a readable reason instead of a 422.
      if (!/^https?:/.test(location.href)) {
        return { ok: false, message: "Only http(s) pages can be archived." };
      }

      try {
        const reply = (await chrome.runtime.sendMessage({
          type: "dp/upload-trace",
          request: {
            scan_id: scanId,
            url: currentDocumentUrl,
            page_score: latestPageScore,
            entries,
          },
        })) as UploadTraceReply | undefined;

        if (reply?.ok) {
          console.log(
            `[dark-pattern-analyzer] trace archived: ${entries.length} candidate(s) -> ${reply.objectKey}`,
          );
          return {
            ok: true,
            message:
              `Saved ${entries.length} candidate(s)` +
              (reply.replaced ? " (replaced this page's earlier capture)." : "."),
          };
        }
        return { ok: false, message: reply?.error ?? "The background worker did not respond." };
      } catch (err) {
        console.warn("[dark-pattern-analyzer] trace upload failed", err);
        return { ok: false, message: "Could not reach the extension's background worker." };
      }
    }

    function applyResults(items: ClassifyItemResult[], documentUrl?: string): void {
      // Results for a page this script is no longer showing. An in-flight
      // batch for the previous route can land seconds after an SPA
      // navigation, and rendering it puts the old page's badges on the new
      // page -- the exact symptom this guard exists to prevent. Undefined is
      // accepted for callers that have no URL to offer.
      if (documentUrl !== undefined && documentUrl !== currentDocumentUrl) {
        console.log(
          `[dark-pattern-analyzer] ignoring ${items.length} result(s) for a different document (${documentUrl})`,
        );
        return;
      }

      const now = Date.now();
      for (const item of items) {
        const labels = item.findings.map((f) => f.label);
        const entry = trace.get(item.id);
        if (entry) {
          entry.findingLabels = labels;
          if (item.withheld?.length) {
            entry.withheld = item.withheld.map((w) => ({ label: w.label, reason: w.reason }));
          }
          entry.lastSeenAt = now;
        } else {
          // A result for an id with no base trace entry (e.g. a progress
          // push racing an in-flight extraction pass) -- recorded anyway so
          // the trace stays complete instead of silently dropping it.
          trace.set(item.id, {
            id: item.id,
            text: item.text,
            tag: item.tag,
            role: item.role,
            field: "unknown",
            step: null,
            selector: item.selector,
            ruleHits: [],
            sentToModel: true,
            withheld: item.withheld?.map((w) => ({ label: w.label, reason: w.reason })),
            findingLabels: labels,
            firstSeenAt: now,
            lastSeenAt: now,
          });
        }
      }
      overlay.update(items);
      scheduleTraceSummaryLog(trace);
    }

    (window as unknown as Record<string, unknown>).__dpTrace = trace;
    (window as unknown as Record<string, unknown>).__dpGroups = proposedGroups;
    (window as unknown as Record<string, unknown>).__dpExportTrace = () =>
      exportTrace(trace, proposedGroups);

    /**
     * Extracted candidates sitting near `selector` in the DOM, for use as
     * context in an LLM explanation.
     *
     * "Near" is defined structurally, not by text similarity: walk up from the
     * target until an ancestor contains a few other registered candidates,
     * then return those. That ancestor is in practice the product card, price
     * block or modal the finding belongs to -- which is exactly the context
     * that makes a finding interpretable ("this countdown sits next to a
     * discounted price and an add-to-cart button") and that the text alone
     * cannot supply.
     *
     * Returns page-authored text. Everything here is untrusted input; the
     * backend fences it and instructs the model to treat it as data (see
     * services/explain.py).
     */
    function collectContext(selector: string): ContextReply["context"] {
      let target: Element | null = null;
      try {
        target = document.querySelector(selector);
      } catch {
        target = null;
      }
      if (!target) return [];

      // Registered candidates that are still attached, excluding the target.
      const live: Array<{ id: string; el: Element }> = [];
      for (const [id, el] of elementRegistry) {
        if (el === target || !el.isConnected) continue;
        live.push({ id, el });
      }

      // Climb until the ancestor holds a useful number of neighbours, bounded
      // so a page with shallow markup doesn't end up handing back the whole
      // <body> (which would be "context" in name only).
      let container: Element | null = target.parentElement;
      let neighbours: Array<{ id: string; el: Element }> = [];
      for (let depth = 0; depth < 5 && container; depth += 1) {
        const inside = live.filter(({ el }) => container!.contains(el));
        if (inside.length >= 3 || depth === 4) {
          neighbours = inside;
          break;
        }
        neighbours = inside;
        container = container.parentElement;
      }

      return neighbours
        .sort((a, b) => {
          // Document order, so the model reads the block roughly as a user
          // would rather than in registry-insertion order.
          const position = a.el.compareDocumentPosition(b.el);
          if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
          if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
          return 0;
        })
        .slice(0, MAX_CONTEXT_SNIPPETS)
        .map(({ id }) => {
          const entry = trace.get(id);
          return {
            text: (entry?.text ?? "").slice(0, MAX_CONTEXT_CHARS),
            tag: entry?.tag ?? "span",
            role: entry?.role ?? "none",
          };
        })
        .filter((c) => c.text.length > 0);
    }

    let debounceHandle: ReturnType<typeof setTimeout> | null = null;
    let lastExtractionAt = 0;

    async function runExtraction() {
      lastExtractionAt = Date.now();
      // Checked first: on an SPA the DOM about to be walked may belong to a
      // different route than the state accumulated so far.
      syncDocumentUrl();
      // Scanning off: no extraction, no rules, no network. Checked here
      // rather than only in background.ts (which also gates) so a disabled
      // scan costs nothing at all on the page -- the previous single-flag
      // design still ran the full extract-and-rules pass on every mutation
      // and only dropped the work at the far end of the message channel.
      if (!settings.scanEnabled) return;
      // New nodes may have appeared -- give previously unresolvable findings
      // another chance to bind to the freshly rendered DOM.
      unresolvable.clear();
      // The cadence tracker is passed in rather than applied afterwards:
      // role inference needs it. A bare "MM:SS" is a countdown only if it
      // ticks -- without that, every video clip length on the page was typed
      // role=timer, and the model was told to read it as urgency.
      const pairs = await extractCandidatesWithElements(lang, document, isAnimated);

      // Record every element's current text on every pass (this function runs
      // on every mutation via the fast observer below, not just the debounced
      // one) so the next pass's cadence reading is current.
      for (const { candidate, el } of pairs) {
        elementRegistry.set(candidate.id, el);
        recordObservation(candidate.selector, candidate.text);
      }

      // Shadow mode: propose semantic units and record them, but send the
      // fragments to the model exactly as before. A grouping change that can
      // silently discard model inputs does not get to run until its proposals
      // have been read against real pages -- see lib/extract/group.ts.
      for (const group of proposeGroups(pairs)) {
        proposedGroups.set(group.id, group);
        for (const memberId of group.memberIds) groupIdByCandidate.set(memberId, group.id);
      }

      const withHits: CandidateWithHits[] = pairs.map(({ candidate, el }) => ({
        candidate,
        ruleHits: runRules(candidate, el),
      }));

      const toSend = withHits.filter(
        ({ candidate }) =>
          !sentIds.has(candidate.id) &&
          !sentChurnKeys.has(churnKeyFor(candidate)) &&
          // Running prose -- a customer review, a Q&A answer -- is writing,
          // not interface copy, and the classifier was fine-tuned on
          // interface copy. Across three real pages it produced 28 of 57
          // findings, every one of them a false positive. Local rules still
          // run on it (a structural gate inside a long modal paragraph is
          // still a gate); only the model round trip is skipped.
          candidate.field !== "prose" &&
          // Structured personal identifiers -- an email address, a
          // card-shaped digit run, an order or account number -- never leave
          // the machine. None of them can be a dark pattern, and until now
          // there was no exclusion of any kind: on a checkout or account page
          // this text was POSTed like any other snippet. See fields.ts for
          // what this does and does not catch.
          candidate.field !== "personal",
      );

      // Base trace entry for every candidate this pass saw, whether new or
      // already sent -- findingLabels stays whatever it already was (null
      // until a response says otherwise) so a repeat sighting of an
      // already-resolved candidate doesn't erase its known outcome.
      const now = Date.now();
      for (const { candidate, ruleHits } of withHits) {
        const existing = trace.get(candidate.id);
        if (existing) {
          existing.lastSeenAt = now;
          continue;
        }
        trace.set(candidate.id, {
          id: candidate.id,
          text: candidate.text,
          tag: candidate.tag,
          role: candidate.role,
          field: candidate.field,
          groupId: groupIdByCandidate.get(candidate.id),
          step: candidate.step,
          selector: candidate.selector,
          ruleHits: ruleHits.map((h) => h.rule),
          sentToModel: false,
          findingLabels: null,
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }

      // console.log, not console.debug -- DevTools hides the "Verbose" level
      // by default, so a debug-level log here silently looks like "nothing
      // happened" even when extraction ran fine. Kept at log level so this
      // is visible without the user knowing to flip the console's level
      // filter. window.__dpLastPairs is a dev-only escape hatch: run
      // `window.__dpLastPairs` in this tab's console (not the service
      // worker's) after a scan to inspect every candidate's exact text,
      // tag and role -- the fastest way to see whether extraction is
      // fragmenting sentences across inline tags or genuinely finding little.
      (window as unknown as Record<string, unknown>).__dpLastPairs = pairs.map(
        ({ candidate }) => ({
          text: candidate.text,
          tag: candidate.tag,
          role: candidate.role,
          field: candidate.field,
        }),
      );
      // `churn-suppressed` counts candidates with an unseen id whose
      // digit-masked key was already sent -- i.e. counters that ticked. A
      // steady non-zero number here is normal and healthy on a page with a
      // countdown; it used to be the number of redundant API round trips per
      // second.
      const churnSuppressed = withHits.filter(
        ({ candidate }) =>
          !sentIds.has(candidate.id) && sentChurnKeys.has(churnKeyFor(candidate)),
      ).length;
      // Logged as a console.log argument (not just "inspect window.X"),
      // same reasoning as overlay.ts's render-debug logging: a typed
      // `window.__dpLastPairs` expression only works if DevTools' Console
      // context dropdown is pointed at this isolated world, which is easy to
      // miss -- console.log output shows up regardless. Limited to the
      // *newly sent* candidates (not all `pairs`) so this doesn't reprint
      // the whole page's candidate list on every debounce tick once the
      // page has settled.
      console.log(
        `[dark-pattern-analyzer] extracted ${pairs.length} candidates, ${toSend.length} new ` +
          `(${churnSuppressed} churn-suppressed, lang=${lang}):`,
        toSend.map(({ candidate }) => ({
          text: candidate.text,
          tag: candidate.tag,
          role: candidate.role,
          selector: candidate.selector,
        })),
      );

      // The registry has just been repointed at the current nodes, so ask the
      // overlay to re-resolve and re-place its badges. This must happen before
      // the early return below: on an SPA the common case after a re-render is
      // *zero* new candidates (same text, new nodes), and that is exactly the
      // case where badges were disappearing until the user next scrolled.
      overlay.refresh();

      if (toSend.length === 0) return;
      // Captured before the await: by the time the response lands, an SPA
      // navigation may have moved currentDocumentUrl on, and these results
      // belong to the page as it was when they were requested.
      const requestedForDocument = currentDocumentUrl;
      for (const { candidate } of toSend) {
        sentIds.add(candidate.id);
        sentChurnKeys.add(churnKeyFor(candidate));
        const entry = trace.get(candidate.id);
        if (entry) entry.sentToModel = true;
      }

      try {
        const response = (await chrome.runtime.sendMessage({
          type: "dp/classify-candidates",
          candidates: toSend,
          pageUrl: currentDocumentUrl,
        })) as ClassifyResultMessage | undefined;

        console.log(
          `[dark-pattern-analyzer] classify response: ${response?.results?.length ?? 0} items, ` +
            `page score ${response?.pageScore ?? "n/a"}`,
        );

        if (typeof response?.pageScore === "number") latestPageScore = response.pageScore;
        if (response?.results) {
          // background.ts's accumulator (see persistProgress) only ever
          // returns candidates with at least one finding -- a benign result
          // is silently absent, by design, to keep the overlay/storage
          // payload small. That means "not in response.results" is not
          // automatically "still pending": for every id in *this* toSend
          // batch specifically, the round trip that just completed
          // processed all of them (background.ts's persistProgress iterates
          // exactly `capped`, i.e. this message's candidates, on every call
          // including the final one) -- so any of *this batch's* ids still
          // missing from the response are confirmed benign, not unresolved.
          // Ids from earlier batches are untouched here; they were already
          // resolved one way or another by their own round trip.
          // (One disclosed edge case: if the accumulator's own
          // MAX_SNIPPETS_PER_PAGE eviction ever kicks in, an evicted
          // non-benign id would also read as "confirmed benign" here --
          // irrelevant in practice at the finding counts seen so far, but
          // not information this diff can distinguish.)
          const returnedIds = new Set(response.results.map((r) => r.id));
          for (const { candidate } of toSend) {
            if (returnedIds.has(candidate.id)) continue;
            const entry = trace.get(candidate.id);
            if (entry) {
              entry.findingLabels = [];
              entry.lastSeenAt = Date.now();
            }
          }
          applyResults(response.results, requestedForDocument);
        }
      } catch (err) {
        // The background worker can be mid-restart, or the backend can be
        // down (docs/FRONTEND.md's "start the backend first" note) -- either
        // way, local rule hits still ran; only the model-backed findings are
        // missing for this pass. Logged, not thrown -- extraction should
        // keep working on later mutations.
        console.error("[dark-pattern-analyzer] classify request failed", err);
      }
    }

    function scheduleExtraction() {
      if (debounceHandle) clearTimeout(debounceHandle);
      // Debounce *and* rate-limit: whichever is later wins. On a page whose
      // mutations never stop, the debounce alone never lets the queue drain.
      const sinceLast = Date.now() - lastExtractionAt;
      const delay = Math.max(DEBOUNCE_MS, MIN_EXTRACTION_INTERVAL_MS - sinceLast);
      debounceHandle = setTimeout(runExtraction, delay);
    }

    // Initial pass.
    scheduleExtraction();

    // SPA route changes. The MutationObserver below would eventually notice
    // (a route change replaces the DOM), but "eventually" is up to
    // MIN_EXTRACTION_INTERVAL_MS away, and until then the old page's badges
    // are still on screen over the new page's content. Reacting to the
    // history events directly clears them immediately.
    //
    // pushState/replaceState fire no event of their own, so a route change
    // that uses them is only caught by the check inside runExtraction. That
    // is the reason syncDocumentUrl() is called there too rather than relying
    // on these listeners alone.
    const onHistoryNavigation = () => {
      if (syncDocumentUrl()) scheduleExtraction();
    };
    window.addEventListener("popstate", onHistoryNavigation);
    window.addEventListener("hashchange", onHistoryNavigation);

    // Debounced at ~300ms per docs/ARCHITECTURE.md 4.1 -- countdown timers
    // mutate every second; without this an undebounced observer floods the API.
    const debouncedObserver = new MutationObserver(scheduleExtraction);
    debouncedObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "checked", "hidden"],
    });

    // A *separate*, undebounced observer purely for timer-cadence tracking
    // (is_animated). It only records text changes locally via
    // recordObservation -- it never triggers a network call or even a full
    // extraction pass. See docs/ARCHITECTURE.md 4.1, "Change detection", and
    // src/lib/timer-tracker.ts.
    const cadenceObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const el =
          mutation.target.nodeType === Node.TEXT_NODE
            ? mutation.target.parentElement
            : (mutation.target as Element);
        if (!el) continue;
        const text = (el.textContent ?? "").trim();
        if (!text) continue;
        // Reuse the same selector strategy candidates use so the reading
        // taken here lines up with the candidate produced on the next
        // debounced extraction pass.
        recordObservation(cssPathFor(el), text);
      }
    });
    cadenceObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    // Listen for the side panel's "scroll to and highlight" requests, and
    // for background.ts's live per-batch progress pushes (so the overlay
    // updates as results come in on slow fp32-CPU pages instead of freezing
    // until the whole page's batches finish -- see background.ts's
    // persistProgress for why).
    chrome.runtime.onMessage.addListener(
      (
        message:
          | ScrollToMessage
          | ClassifyProgressMessage
          | ExportTraceMessage
          | GetContextMessage
          | UploadTraceNowMessage,
        _sender,
        sendResponse,
      ) => {
        if (message.type === "dp/upload-trace-now") {
          // Async: keep the channel open so the caller gets the real outcome
          // rather than an optimistic "sent" it cannot act on.
          void uploadTrace().then(sendResponse);
          return true;
        }
        if (message.type === "dp/get-context") {
          // Synchronous: collectContext only reads the DOM and the local
          // registry, so this returns false (channel closed immediately)
          // rather than holding the port open for nothing.
          sendResponse({ context: collectContext(message.selector) } satisfies ContextReply);
          return false;
        }
        if (message.type === "dp/scroll-to") {
          scrollAndHighlight(message.selector);
        } else if (message.type === "dp/export-trace") {
          // Popup-triggered, not a console command -- see messaging.ts's
          // ExportTraceMessage doc comment for why.
          exportTrace(trace, proposedGroups);
        } else if (message.type === "dp/classify-progress") {
          // Primary overlay update path: pushed from background.ts after
          // every batch. Now works on real e-commerce pages because
          // wxt.config.ts gained "*://*/*" in host_permissions (MV3
          // requires the destination tab's origin to be listed there for
          // chrome.tabs.sendMessage from a service worker to succeed).
          console.log(
            `[dark-pattern-analyzer] dp/classify-progress received: ${message.results.length} item(s)`,
          );
          latestPageScore = message.pageScore;
          applyResults(message.results, message.documentUrl);
        }
      },
    );
    console.log("[dark-pattern-analyzer] dp/classify-progress listener registered");

    // Belt-and-suspenders: also watch chrome.storage.session for the
    // findings key that background.ts writes after every batch. This path
    // doesn't need host_permissions and survives service-worker restarts,
    // so it works even if the sendMessage push above fails (e.g. during
    // extension dev reload races). The popup already uses this path
    // successfully, which is why the popup always showed findings even when
    // the overlay didn't.
    //
    // To subscribe to the right key we first ask the background worker for
    // our tabId (content scripts have no direct chrome.tabs API).
    //
    // This ask is RETRIED, and that matters more than it looks. An MV3
    // service worker is killed aggressively and started lazily, so on a fresh
    // page load the worker is very often asleep at exactly the moment this
    // runs. The previous single-shot version treated that as terminal: the
    // promise rejected, the failure was logged, and the storage.onChanged
    // path stayed disabled for the entire life of the page. Whether badges
    // appeared then depended on whether the classify-progress push happened
    // to arrive -- which is why reloading two or three times "fixed" it.
    // Retrying makes the subscription reliable on the first load instead of
    // by luck.
    const TAB_ID_RETRY_DELAYS_MS = [0, 100, 300, 800, 2000];

    async function subscribeToFindings(): Promise<void> {
      for (const [attempt, delay] of TAB_ID_RETRY_DELAYS_MS.entries()) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          const resp = (await chrome.runtime.sendMessage({ type: "dp/get-tab-id" })) as
            | { tabId: number | null }
            | undefined;
          const tabId = resp?.tabId;
          if (!tabId) continue;

          const storageKey = findingsStorageKey(tabId);
          console.log(
            `[dark-pattern-analyzer] subscribing storage.onChanged on key "${storageKey}"` +
              (attempt > 0 ? ` (after ${attempt} retry/retries)` : ""),
          );
          chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "session" || !(storageKey in changes)) return;
            const newValue = changes[storageKey]?.newValue as StoredFindings | undefined;
            if (!newValue?.items) return;
            console.log(
              `[dark-pattern-analyzer] storage.onChanged overlay update: ${newValue.items.length} item(s)`,
            );
            applyResults(newValue.items, newValue.documentUrl);
          });
          return;
        } catch {
          // Worker asleep or mid-restart. Fall through to the next delay.
        }
      }
      console.warn(
        "[dark-pattern-analyzer] dp/get-tab-id failed after " +
          `${TAB_ID_RETRY_DELAYS_MS.length} attempts -- storage.onChanged path disabled. ` +
          "Badges will still update via dp/classify-progress pushes.",
      );
    }

    void subscribeToFindings();
  },
});

/**
 * Rolling log of failed/downgraded resolutions, for the same reason
 * window.__dpRenderDebug and window.__dpLastPairs exist: a dev-only way to
 * see *why* a finding has no badge without attaching a debugger. Reassigned
 * (not appended) each time, capped, so it never grows unbounded across a
 * long-lived tab. Anything other than "not-found" (a same-tag/same-text
 * element existed but the resolver refused to guess, or a claim collision
 * was avoided) is worth a console line too -- these are exactly the cases
 * Fix 2 exists to make visible instead of silently wrong.
 */
const RESOLVE_DEBUG_LIMIT = 200;
const resolveDebugLog: ResolveDiagnostic[] = [];
let resolveSummaryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A resolveOccurrence() call happens once per rendered item, so a whole
 * render pass fires this dozens of times in a row -- logging a summary on
 * every call would spam the console far worse than the plain "undefined"
 * problem it's meant to fix. Trailing-debounced: whichever call is *last* in
 * a burst is the one that actually prints, ~80ms after the burst quiets
 * down, giving one summary line per render pass instead of one per item.
 */
function scheduleResolveSummaryLog(): void {
  if (resolveSummaryTimer) clearTimeout(resolveSummaryTimer);
  resolveSummaryTimer = setTimeout(() => {
    resolveSummaryTimer = null;
    const byOutcome = resolveDebugLog.reduce<Record<string, number>>((acc, d) => {
      acc[d.outcome] = (acc[d.outcome] ?? 0) + 1;
      return acc;
    }, {});
    // Plain console.log, not just the window.__dpResolveDebug assignment --
    // see overlay.ts's matching comment: DevTools' Console evaluates typed
    // expressions against whichever context is selected in its dropdown
    // (defaults to the page's main world, not this isolated-world global),
    // so a user who hasn't switched contexts sees "undefined" no matter how
    // much data is actually sitting on this window. console.log output does
    // not have that problem.
    console.log(
      `[dark-pattern-analyzer] resolve: ${resolveDebugLog.length} recent lookup(s) -- ${JSON.stringify(byOutcome)}`,
      resolveDebugLog,
    );
  }, 80);
}

function recordResolveDiagnostic(diagnostic: ResolveDiagnostic): void {
  if (diagnostic.outcome === "ambiguous" || diagnostic.outcome === "claimed") {
    console.warn(
      `[dark-pattern-analyzer] resolve: ${diagnostic.outcome} for "${diagnostic.text}" ` +
        `(id=${diagnostic.id}${diagnostic.matchCount ? `, ${diagnostic.matchCount} candidates` : ""}) ` +
        `-- refusing to guess, badge withheld this pass.`,
    );
  }
  resolveDebugLog.push(diagnostic);
  if (resolveDebugLog.length > RESOLVE_DEBUG_LIMIT) resolveDebugLog.shift();
  (window as unknown as Record<string, unknown>).__dpResolveDebug = resolveDebugLog;
  scheduleResolveSummaryLog();
}

let traceSummaryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Trailing-debounced console.table dump of the full extraction ->
 * classification trace -- same reasoning as scheduleResolveSummaryLog:
 * printed automatically so it's visible without typing a `window.__dpTrace`
 * expression into whatever context DevTools happens to have selected.
 * console.table renders one row per candidate with columns for text/tag/
 * role/sent/findings, which is what makes "compare this product's title to
 * that one's" a five-second visual scan instead of expanding hundreds of
 * collapsed objects by hand.
 */
function scheduleTraceSummaryLog(trace: ReadonlyMap<string, TraceEntry>): void {
  if (traceSummaryTimer) clearTimeout(traceSummaryTimer);
  traceSummaryTimer = setTimeout(() => {
    traceSummaryTimer = null;
    const rows = [...trace.values()];
    // "not-sent" (a churn-suppressed duplicate -- see churnKeyFor, e.g. a
    // countdown timer's later ticks reusing the first tick's classification)
    // is deliberately its own bucket, distinct from "awaiting" (genuinely
    // sent, response not observed yet). The two look identical if you only
    // check `findingLabels === null` -- conflating them is exactly what
    // made an intentionally-skipped duplicate look like a stuck request the
    // first time this trace was read.
    const counts = rows.reduce(
      (acc, r) => {
        if (r.findingLabels !== null) {
          if (r.findingLabels.length === 0) acc.benign += 1;
          else acc.flagged += 1;
        } else if (r.sentToModel) {
          acc.awaiting += 1;
        } else {
          acc.notSent += 1;
        }
        return acc;
      },
      { flagged: 0, benign: 0, awaiting: 0, notSent: 0 },
    );
    console.log(
      `[dark-pattern-analyzer] trace: ${rows.length} candidate(s) total -- ` +
        `${counts.flagged} flagged, ${counts.benign} confirmed benign, ` +
        `${counts.awaiting} awaiting response, ${counts.notSent} not sent (duplicates). ` +
        `Run window.__dpExportTrace() to download the full trace as JSON.`,
    );
    console.table(
      rows.map((r) => ({
        text: r.text.length > 60 ? `${r.text.slice(0, 60)}…` : r.text,
        tag: r.tag,
        role: r.role,
        field: r.field,
        step: r.step,
        sent: r.sentToModel,
        status:
          r.findingLabels === null
            ? r.sentToModel
              ? "awaiting"
              : "not-sent (duplicate)"
            : r.findingLabels.length === 0
              ? "benign"
              : r.findingLabels.join("+"),
        ruleHits: r.ruleHits.join(",") || undefined,
        withheld: r.withheld?.map((w) => w.label).join(",") || undefined,
      })),
    );
  }, 400);
}

/**
 * Downloads the complete, untruncated trace as a JSON file -- for pasting
 * slices elsewhere, diffing two page loads, or grepping locally in a way
 * the console's row limit and object truncation don't allow. Exposed as
 * window.__dpExportTrace(); no `downloads` permission needed since this is
 * just a same-page anchor-click download, not the chrome.downloads API.
 */
function exportTrace(
  trace: ReadonlyMap<string, TraceEntry>,
  groups: ReadonlyMap<string, ProposedGroup>,
): void {
  const rows = [...trace.values()];
  // Shape changed when shadow grouping arrived: v1 was a bare array of rows.
  // The version marker is here so a reader never has to guess which it has --
  // an older trace and a newer one are both valid captures of their build.
  const payload = {
    version: 2,
    url: stripFragment(location.href),
    capturedAt: new Date().toISOString(),
    rows,
    proposedGroups: [...groups.values()],
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `dark-pattern-analyzer-trace-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  console.log(
    `[dark-pattern-analyzer] exported ${rows.length} trace row(s) and ` +
      `${groups.size} proposed group(s) (shadow mode -- proposals only).`,
  );
}

/** Lightweight local mirror of selector.ts's stableSelector, used only by
 * the cadence observer above so it doesn't need to import the extraction
 * module's internals for a value it discards after tracking. Intentionally
 * simple -- collisions here only cost a missed cadence match, not a wrong
 * classification. */
function cssPathFor(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && parts.length < 4) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${part}#${node.id}`);
      break;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(">");
}