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
    const overlay = mountOverlay();
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
        recordObservation(candidate.selector, candidate.text);
        candidate.is_animated = isAnimated(candidate.selector);
      }

      const withHits: CandidateWithHits[] = pairs.map(({ candidate, el }) => ({
        candidate,
        ruleHits: runRules(candidate, el),
      }));

      const toSend = withHits.filter(({ candidate }) => !sentIds.has(candidate.id));
      if (toSend.length === 0) return;
      for (const { candidate } of toSend) sentIds.add(candidate.id);

      console.debug(
        `[dark-pattern-analyzer] extracted ${pairs.length} candidates, ${toSend.length} new`,
      );

      try {
        const response = (await chrome.runtime.sendMessage({
          type: "dp/classify-candidates",
          candidates: toSend,
        })) as ClassifyResultMessage | undefined;

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

    // Listen for the side panel's "scroll to and highlight" requests.
    chrome.runtime.onMessage.addListener((message: ScrollToMessage) => {
      if (message.type === "dp/scroll-to") {
        scrollAndHighlight(message.selector);
      }
    });
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
