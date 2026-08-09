import type { Rule } from "./types";

/**
 * Fires when the candidate's digits have been observed changing on a ~1s
 * cadence. See docs/ARCHITECTURE.md 4.5.
 *
 * The cadence detection itself happens in entrypoints/content.ts's dedicated
 * (undebounced, local-only) MutationObserver -- this rule just reads the
 * `is_animated` flag it sets on the candidate. Splitting it this way keeps
 * the rule pure and synchronous, and keeps the actual per-tick DOM
 * observation in exactly one place.
 */
export const countdownTimer: Rule = (candidate) => {
  if (!candidate.is_animated) return [];
  return [{ rule: "countdown_timer", label: "false_urgency" }];
};
