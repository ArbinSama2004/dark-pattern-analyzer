import type { Rule } from "./types";

/**
 * "Only N left" per language, or a visibly decrementing count.
 * See docs/ARCHITECTURE.md 4.5. This is the template for the remaining 7
 * rules (countdown_timer, viewer_counter, prechecked_optin, hidden_optout,
 * cta_asymmetry, late_fee, cancel_offsite) -- same shape: inspect the
 * candidate/element, return RuleHit[] or [].
 */
const STOCK_PATTERNS: RegExp[] = [
  /only\s+\d+\s+left/i, // en
  /केवल\s*\d+\s*(बाकी|बाँकी)/, // hi / ne
  /\d+\s*(बाकी|बाँकी)\s*(छ|है)/, // ne / hi, count-first phrasing
];

export const stockCounter: Rule = (candidate) => {
  const matches = STOCK_PATTERNS.some((re) => re.test(candidate.text));
  if (!matches) return [];
  return [{ rule: "stock_counter", label: "scarcity" }];
};
