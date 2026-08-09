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
    const overlay = mountOverlay((item) => elementRegistry.get(item.id) ?? null);
    // Ids already sent to background this session -- avoid resending a
    // candidate the backend has already resolved (docs/ARCHITECTURE.md 4.1,
    // "Hash and dedupe"). The background worker also dedupes independently
    // (its cache survives worker restarts, this doesn't need to), but
    // skipping the resend here saves the message-passing round trip too.
    const sentIds = new Set<string>();

    let debounceHandle: ReturnType<typeof setTimeout> | null = null;

    async function runExtraction() {
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

      const toSend = withHits.filter(({ candidate }) => !sentIds.has(candidate.id));

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
      console.log(
        `[dark-pattern-analyzer] extracted ${pairs.length} candidates, ${toSend.length} new ` +
          `(lang=${lang}). Inspect window.__dpLastPairs for the exact text sent.`,
      );

      if (toSend.length === 0) return;
      for (const { candidate } of toSend) sentIds.add(candidate.id);

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
      debounceHandle = setTimeout(runExtraction, DEBOUNCE_MS);
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
          const newValue = changes[storageKey].newValue as
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