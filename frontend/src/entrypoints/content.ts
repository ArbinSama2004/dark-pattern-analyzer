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
 * `candidate.id` is sha1(lang + text), so a countdown timer, a stock counter
 * and a "N people are viewing this" line all mint a brand-new id on every
 * tick. Nothing then matches `sentIds`, and the page re-classifies that
 * snippet once a second for as long as the tab is open -- visible on Daraz as
 * an endless run of "extracted 130 candidates, 1 new" in the console.
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
    // Live element registry, keyed by the same content-hash id used for
    // dedupe/caching (hash.ts / snippetId). Refreshed on every extraction
    // pass. This is what lets the overlay find the right node even after a
    // framework re-render has invalidated a positionally-computed selector
    // -- see ui/overlay.ts's resolveElement doc comment. Elements for ids
    // no longer present on the page are left in place rather than pruned;
    // overlay.ts checks `el.isConnected` before using one, so a stale
    // entry just gets skipped, not resurrected.
    const elementRegistry = new Map<string, Element>();

    /**
     * Ids we failed to re-locate since the last extraction pass. Without this,
     * every unresolvable item would trigger a full-document text scan on every
     * scroll frame. Cleared at the start of each extraction pass, because that
     * is the only moment new nodes can have appeared.
     */
    const unresolvable = new Set<string>();

    /**
     * Three-tier resolution, in decreasing order of confidence:
     *
     *   1. the live registry, if its node is still attached;
     *   2. the positional CSS path captured at extraction time;
     *   3. a text scan of the current document.
     *
     * Tier 1 alone was the bug behind disappearing badges on SPAs like Jeevee:
     * when the framework re-renders a subtree it replaces the nodes, so the
     * registry entry becomes a detached element. overlay.ts checks
     * `isConnected` and skips it -- but the `?? document.querySelector(...)`
     * fallback there never fired, because a *detached* element is still
     * non-null. The badge silently vanished with no fallback attempted.
     * Deleting the dead entry here is what re-arms tiers 2 and 3.
     */
    function resolveForItem(item: ClassifyItemResult): Element | null {
      const cached = elementRegistry.get(item.id);
      if (cached?.isConnected) return cached;
      if (cached) elementRegistry.delete(item.id);
      if (unresolvable.has(item.id)) return null;

      const bySelector = querySelectorSafe(item.selector);
      if (bySelector && textMatches(bySelector, item.text)) {
        elementRegistry.set(item.id, bySelector);
        return bySelector;
      }

      // A re-render usually keeps the *text* even when it changes the DOM
      // path, so matching on the candidate's own text is the most durable
      // handle we have. Costly, hence the negative cache above.
      const byText = findElementByText(item.text);
      if (byText) {
        elementRegistry.set(item.id, byText);
        return byText;
      }

      // Last resort: the selector resolved to *something* whose text has
      // since changed (a countdown timer's own node, typically). Better to
      // badge that than to drop the finding entirely.
      if (bySelector) {
        elementRegistry.set(item.id, bySelector);
        return bySelector;
      }

      unresolvable.add(item.id);
      return null;
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

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** `document.querySelector` never throws on a *stale* selector, but a path
 * built around an id that contained exotic characters can still be rejected
 * as a syntax error. A throw here would abort the whole render loop. */
function querySelectorSafe(selector: string): Element | null {
  if (!selector) return null;
  try {
    return document.querySelector(selector);
  } catch {
    return null;
  }
}

function textMatches(el: Element, text: string): boolean {
  const target = normalizeText(text);
  if (!target) return false;
  const actual = normalizeText(el.textContent);
  // Extraction may have used only the element's *direct* text, or joined its
  // inline children (extract.ts's leafBlockText), so containment in either
  // direction is the honest comparison -- exact equality would reject
  // legitimate matches.
  return actual === target || actual.includes(target);
}

/** Elements scanned before giving up on a text lookup. A cap matters: on a
 * large listing page an unbounded scan runs per unresolved finding. */
const TEXT_SCAN_LIMIT = 4000;

/**
 * Finds the *deepest* element whose text matches, so we badge the price tag
 * rather than the product card that contains it. Returns null rather than
 * guessing when nothing matches.
 */
function findElementByText(text: string): Element | null {
  const target = normalizeText(text);
  if (target.length < 3) return null;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let best: Element | null = null;
  let bestDepth = -1;
  let scanned = 0;

  let node = walker.nextNode() as Element | null;
  while (node && scanned < TEXT_SCAN_LIMIT) {
    scanned += 1;
    const el = node;
    node = walker.nextNode() as Element | null;

    if (el.id === "dark-pattern-analyzer-overlay-host") continue;
    const actual = normalizeText(el.textContent);
    // Cheap reject first: containment is far cheaper than the depth walk.
    if (!actual.includes(target)) continue;

    let depth = 0;
    for (let p = el.parentElement; p; p = p.parentElement) depth += 1;
    if (depth > bestDepth) {
      best = el;
      bestDepth = depth;
    }
  }
  return best;
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