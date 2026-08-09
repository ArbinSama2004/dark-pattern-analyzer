import type { Rule } from "./types";

const AREA_RATIO_THRESHOLD = 3;
const SEARCH_ANCESTOR_LEVELS = 4;
const BUTTON_LIKE_SELECTOR = 'button, [role="button"], input[type="submit"], a.btn, a.button';

function area(el: Element): number {
  const rect = el.getBoundingClientRect();
  return rect.width * rect.height;
}

/** Walks up a bounded number of ancestor levels looking for the largest
 * other button-like element -- a reasonable proxy for "the accept button
 * this decline button is paired against" without needing an explicit
 * accept/decline pairing to be modeled in the DOM. */
function findLikelyAcceptButton(declineEl: Element): Element | null {
  let scope: Element | null = declineEl.parentElement;
  for (let i = 0; i < SEARCH_ANCESTOR_LEVELS && scope; i++) {
    const candidates = Array.from(scope.querySelectorAll(BUTTON_LIKE_SELECTOR)).filter(
      (el) => el !== declineEl,
    );
    if (candidates.length > 0) {
      return candidates.reduce((largest, el) =>
        area(el) > area(largest) ? el : largest,
      );
    }
    scope = scope.parentElement;
  }
  return null;
}

/**
 * Accept button area more than 3x the decline button's area. See
 * docs/ARCHITECTURE.md 4.5.
 *
 * Only meaningful in a real browser layout -- getBoundingClientRect returns
 * all-zero rects in jsdom unless a test explicitly stubs it, which the test
 * file for this rule does.
 */
export const ctaAsymmetry: Rule = (candidate, el) => {
  if (candidate.role !== "decline") return [];
  if (!(el instanceof HTMLElement)) return [];

  const declineArea = area(el);
  if (declineArea <= 0) return [];

  const acceptEl = findLikelyAcceptButton(el);
  if (!acceptEl) return [];

  const acceptArea = area(acceptEl);
  if (acceptArea <= 0) return [];

  if (acceptArea / declineArea > AREA_RATIO_THRESHOLD) {
    return [{ rule: "cta_asymmetry", label: "obstruction" }];
  }
  return [];
};
