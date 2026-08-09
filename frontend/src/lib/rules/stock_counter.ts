import type { Rule } from "./types";

/**
 * "Only N left" per language, or a visibly decrementing count.
 * See docs/ARCHITECTURE.md 4.5. This is the template for the remaining 7
 * rules (countdown_timer, viewer_counter, prechecked_optin, hidden_optout,
 * cta_asymmetry, late_fee, cancel_offsite) -- same shape: inspect the
 * candidate/element, return RuleHit[] or [].
 */
const STOCK_PATTERNS: RegExp[] = [
  /only\s+\d+\s+left/i,             // en: "Only 5 left"
  /केवल\s*\d+\s*(बाकी|बाँकी)/,       // hi / ne
  /\d+\s*(बाकी|बाँकी)\s*(छ|है)/,     // ne / hi, count-first phrasing
  /\d+\s*(pieces?\s*)?sold/i,        // "50 pieces sold", "100+ sold" (social proof used as scarcity)
  /\d+\+?\s*sold/i,                  // "100+ sold"
  /lowest\s+price/i,                 // "Lowest Price" urgency badge on Daraz
  /limited\s+(time|offer|stock)/i,   // "Limited time offer"
  /hurry[!,\s]/i,                    // "Hurry!" urgency callout
];

export const stockCounter: Rule = (candidate) => {
  const matches = STOCK_PATTERNS.some((re) => re.test(candidate.text));
  if (!matches) return [];
  return [{ rule: "stock_counter", label: "scarcity" }];
};
