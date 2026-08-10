/**
 * Content script: extracts candidates, runs local rules, tracks timer
 * cadence, sends new candidates to background.ts for classification, and
 * renders the overlay with the merged results. See docs/ARCHITECTURE.md 4.1
 * and frontend/README.md.
 */
import { extractCandidatesWithElements } from "../lib/extract/extract";
import { runRules } from "../lib/rules";
import type { Lang } from "../lib/taxonomy";
import type {
  CandidateWithHits,
  ClassifyItemResult,
  ClassifyProgressMessage,
  ClassifyResultMessage,
  ExportTraceMessage,
  ScrollToMessage,
} from "../lib/messaging";
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
  step: string | null;
  selector: string;
  /** Local rule names that fired for this candidate (independent of the
   * model -- see rules/index.ts). */
  ruleHits: string[];
  sentToModel: boolean;
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

    /**
     * Single funnel for every place a results list arrives (the direct
     * sendMessage response, background.ts's per-batch classify-progress
     * push, and the chrome.storage.onChanged fallback) -- updates `trace`
     * with what each item's findings actually are, then does what the three
     * call sites already did (overlay.update), then schedules the debounced
     * console table so the trace is visible without typing anything.
     */
    function applyResults(items: ClassifyItemResult[]): void {
      const now = Date.now();
      for (const item of items) {
        const labels = item.findings.map((f) => f.label);
        const entry = trace.get(item.id);
        if (entry) {
          entry.findingLabels = labels;
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
            step: null,
            selector: item.selector,
            ruleHits: [],
            sentToModel: true,
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
    (window as unknown as Record<string, unknown>).__dpExportTrace = () => exportTrace(trace);

    let debounceHandle: ReturnType<typeof setTimeout> | null = null;
    let lastExtractionAt = 0;

    async function runExtraction() {
      lastExtractionAt = Date.now();
      // Scanning off: no extraction, no rules, no network. Checked here
      // rather than only in background.ts (which also gates) so a disabled
      // scan costs nothing at all on the page -- the previous single-flag
      // design still ran the full extract-and-rules pass on every mutation
      // and only dropped the work at the far end of the message channel.
      if (!settings.scanEnabled) return;
      // New nodes may have appeared -- give previously unresolvable findings
      // another chance to bind to the freshly rendered DOM.
      unresolvable.clear();
      const pairs = await extractCandidatesWithElements(lang);

      // Timer cadence: record every element's current text on every pass
      // (this function itself runs on every mutation via the fast observer
      // below, not just the debounced one) so is_animated can be measured
      // before rules run.
      for (const { candidate, el } of pairs) {
        elementRegistry.set(candidate.id, el);
        recordObservation(candidate.selector, candidate.text);
        candidate.is_animated = isAnimated(candidate.selector);
      }

      const withHits: CandidateWithHits[] = pairs.map(({ candidate, el }) => ({
        candidate,
        ruleHits: runRules(candidate, el),
      }));

      const toSend = withHits.filter(
        ({ candidate }) =>
          !sentIds.has(candidate.id) && !sentChurnKeys.has(churnKeyFor(candidate)),
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
        ({ candidate }) => ({ text: candidate.text, tag: candidate.tag, role: candidate.role }),
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
        })) as ClassifyResultMessage | undefined;

        console.log(
          `[dark-pattern-analyzer] classify response: ${response?.results?.length ?? 0} items, ` +
            `page score ${response?.pageScore ?? "n/a"}`,
        );

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
          applyResults(response.results);
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
      (message: ScrollToMessage | ClassifyProgressMessage | ExportTraceMessage) => {
        if (message.type === "dp/scroll-to") {
          scrollAndHighlight(message.selector);
        } else if (message.type === "dp/export-trace") {
          // Popup-triggered, not a console command -- see messaging.ts's
          // ExportTraceMessage doc comment for why.
          exportTrace(trace);
        } else if (message.type === "dp/classify-progress") {
          // Primary overlay update path: pushed from background.ts after
          // every batch. Now works on real e-commerce pages because
          // wxt.config.ts gained "*://*/*" in host_permissions (MV3
          // requires the destination tab's origin to be listed there for
          // chrome.tabs.sendMessage from a service worker to succeed).
          console.log(
            `[dark-pattern-analyzer] dp/classify-progress received: ${message.results.length} item(s)`,
          );
          applyResults(message.results);
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
    // our tabId (content scripts have no direct chrome.tabs API). The ask
    // is fire-and-forget -- if the background is not ready yet it will be
    // caught and logged below.
    chrome.runtime
      .sendMessage({ type: "dp/get-tab-id" })
      .then((resp: { tabId: number | null }) => {
        const tabId = resp?.tabId;
        if (!tabId) {
          console.warn(
            "[dark-pattern-analyzer] dp/get-tab-id returned no tabId -- storage.onChanged path disabled",
          );
          return;
        }
        const storageKey = `findings:${tabId}`;
        console.log(
          `[dark-pattern-analyzer] subscribing storage.onChanged on key "${storageKey}"`,
        );
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "session" || !(storageKey in changes)) return;
          const newValue = changes[storageKey]?.newValue as
            | { items: ClassifyItemResult[]; pageScore: number }
            | undefined;
          if (!newValue?.items) return;
          console.log(
            `[dark-pattern-analyzer] storage.onChanged overlay update: ${newValue.items.length} item(s)`,
          );
          applyResults(newValue.items);
        });
      })
      .catch((err: unknown) =>
        console.warn("[dark-pattern-analyzer] dp/get-tab-id failed:", err),
      );
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
function exportTrace(trace: ReadonlyMap<string, TraceEntry>): void {
  const rows = [...trace.values()];
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `dark-pattern-analyzer-trace-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  console.log(`[dark-pattern-analyzer] exported ${rows.length} trace row(s).`);
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