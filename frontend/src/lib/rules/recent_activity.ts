import type { Rule } from "./types";

/**
 * Purchase activity bounded to a recent window: "61 people bought this in the
 * last 24 hours", "12 sold in the past hour".
 *
 * This is the half of the "N sold" question that genuinely *is* a dark pattern,
 * and it is the boundary docs/ANNOTATION.md draws:
 *
 *   dark   "{N} bought in the last {H} hours"   -- unverifiable live activity
 *   benign "Bestseller - {N} sold this week"    -- a settled, auditable total
 *
 * The distinction is the **time bound**, not the number. A cumulative sale count
 * is a statistic you could in principle audit; a count scoped to the last few
 * hours is a claim about right now that no shopper can check, and it exists to
 * manufacture peer pressure. `stock_counter` used to match both and call them
 * `scarcity`; see the comment there for what that cost when measured.
 *
 * Labelled `social_proof`, not `scarcity`: nothing here says the item is running
 * out. It says other people are buying it.
 *
 * Deliberately narrow. It requires an explicit recency phrase, so a bare
 * "330 sold" produces nothing at all -- which is the correct outcome, and
 * exactly what the previous over-broad rule got wrong.
 */
const RECENT_ACTIVITY_PATTERNS: RegExp[] = [
  // en: "<N> (people) bought/sold/purchased ... in the last/past <window>"
  /\d[\d,]*\+?\s*(people|users?|customers?|shoppers?)?\s*(have\s+)?(bought|purchased|sold|ordered)\b[^.]{0,40}\b(in|within|over)\s+the\s+(last|past)\s+\d*\s*(second|minute|hour|day|week|month)/i,
  // en, count-last: "in the last 24 hours, 61 people bought this"
  /\b(in|within|over)\s+the\s+(last|past)\s+\d*\s*(second|minute|hour|day|week|month)[^.]{0,40}\d[\d,]*\+?\s*(people|users?|customers?|shoppers?)?\s*(have\s+)?(bought|purchased|sold|ordered)\b/i,
  // en: "selling fast", "N sold in the last hour" style urgency framing
  /\b(selling|going)\s+fast\b/i,
  // hi: "पिछले <N> घंटों में <N> लोगों ने खरीदा"
  /(पिछले|बीते)\s*\d*\s*(घंटे|घंटों|दिन|दिनों)\s*में[^।]{0,40}(खरीदा|खरीदे|ऑर्डर)/,
  // ne: "गत <N> घण्टामा <N> जनाले किने"
  /(गत|विगत)\s*\d*\s*(घण्टा|घण्टामा|दिन|दिनमा)[^।]{0,40}(किने|किन्नुभयो|अर्डर)/,
];

export const recentActivity: Rule = (candidate) => {
  const matches = RECENT_ACTIVITY_PATTERNS.some((re) => re.test(candidate.text));
  if (!matches) return [];
  return [{ rule: "recent_activity", label: "social_proof" }];
};
