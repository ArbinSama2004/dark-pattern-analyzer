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
  ScrollToMessage,
} from "../lib/messaging";
import { recordObservation, isAnimated } from "../lib/timer-tracker";
import { mountOverlay, scrollAndHighlight } from "../ui/overlay";
import { resolveOccurrence, type ResolveDiagnostic } from "../lib/resolve";

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
    // Ids already sent to background this session -- avoid resending a
    // candidate the backend has already resolved (docs/ARCHITECTURE.md 4.1,
    // "Hash and dedupe"). The background worker also dedupes independently
    // (its cache survives worker restarts, this doesn't need to), but
    // skipping the resend here saves the message-passing round trip too.
    const sentIds = new Set<string>();
    /** Same purpose as `sentIds`, but keyed so a ticking counter maps onto one
     * entry instead of a fresh one per tick -- see churnKeyFor. */
    const sentChurnKeys = new Set<string>();

    let debounceHandle: ReturnType<typeof setTimeout> | null = null;
    let lastExtractionAt = 0;

    async function runExtraction() {
      lastExtractionAt = Date.now();
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
      console.log(
        `[dark-pattern-analyzer] extracted ${pairs.length} candidates, ${toSend.length} new ` +
          `(${churnSuppressed} churn-suppressed, lang=${lang}). ` +
          `Inspect window.__dpLastPairs for the exact text sent.`,
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
          overlay.update(response.results);
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
      (message: ScrollToMessage | ClassifyProgressMessage) => {
        if (message.type === "dp/scroll-to") {
          scrollAndHighlight(message.selector);
        } else if (message.type === "dp/classify-progress") {
          // Primary overlay update path: pushed from background.ts after
          // every batch. Now works on real e-commerce pages because
          // wxt.config.ts gained "*://*/*" in host_permissions (MV3
          // requires the destination tab's origin to be listed there for
          // chrome.tabs.sendMessage from a service worker to succeed).
          console.log(
            `[dark-pattern-analyzer] dp/classify-progress received: ${message.results.length} item(s)`,
          );
          overlay.update(message.results);
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
          overlay.update(newValue.items);
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