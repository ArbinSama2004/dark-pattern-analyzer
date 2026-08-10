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
  /lowest\s+price/i,                 // "Lowest Price" urgency badge on Daraz
  /limited\s+(time|offer|stock)/i,   // "Limited time offer"
  /hurry[!,\s]/i,                    // "Hurry!" urgency callout
];

// REMOVED, and deliberately not restored:
//
//   /\d+\s*(pieces?\s*)?sold/i      "50 pieces sold", "100+ sold"
//   /\d+\+?\s*sold/i                "100+ sold"
//
// These matched a bare cumulative sale count and labelled it `scarcity`, on the
// reasoning (per the original comment) that it was "social proof used as
// scarcity". docs/ANNOTATION.md's core test says the opposite: a **settled,
// verifiable aggregate** is benign, and it lists "Bestseller - {N} sold this
// week" explicitly in the benign column. The rule and the annotation guide held
// contradictory definitions of the same phrase.
//
// It was not a theoretical disagreement. On a 400-snippet real-site sample
// (docs/RESULTS.md sections 6-7) these two patterns produced **39 false
// positives -- 44% of every false positive measured** -- and drove `scarcity`
// precision from 1.000 down to 0.093, which by itself made the whole rule layer
// score *worse* than the model alone.
//
// What is genuinely dark is a purchase count **bounded to a recent window**
// ("61 people bought this in the last 24 hours"), which is unverifiable
// real-time activity rather than a settled total. That is social proof, not
// scarcity, and it now lives in recent_activity.ts.

export const stockCounter: Rule = (candidate) => {
  const matches = STOCK_PATTERNS.some((re) => re.test(candidate.text));
  if (!matches) return [];
  return [{ rule: "stock_counter", label: "scarcity" }];
};
