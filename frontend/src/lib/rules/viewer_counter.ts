import type { Rule } from "./types";

/**
 * "N people viewing/watching" per language. See docs/ARCHITECTURE.md 4.5.
 *
 * Scoping note: ARCHITECTURE.md also lists "+ value churn" as a signal --
 * i.e. the count itself changing over time, the same way countdown_timer
 * uses is_animated. That would need cross-tick state this rule doesn't have
 * (a single candidate snapshot, not a session history), so this
 * implementation is text-pattern-only, same honest boundary stock_counter
 * documents in its own tests. A churning viewer count still gets flagged
 * separately by countdown_timer's is_animated check if its digits are
 * observed changing, since that detector doesn't care what the digits mean.
 */
const VIEWER_PATTERNS: RegExp[] = [
  /\d[\d,]*\s*(people|users?)?\s*(are\s+)?(currently\s+)?(viewing|watching|looking at this)/i, // en
  /\d[\d,]*\s*(लोग|व्यक्ति)\s*(देख रहे|देखा रहे)/, // hi
  /\d[\d,]*\s*जना\s*(हेर्दैछन्|हेरिरहेका छन्)/, // ne
];

export const viewerCounter: Rule = (candidate) => {
  const matches = VIEWER_PATTERNS.some((re) => re.test(candidate.text));
  if (!matches) return [];
  return [{ rule: "viewer_counter", label: "social_proof" }];
};
