import type { Candidate } from "../extract/types";
import type { DARK_LABELS } from "../taxonomy";

export type RuleLabel = (typeof DARK_LABELS)[number];

export interface RuleHit {
  rule: string; // e.g. "stock_counter"
  label: RuleLabel;
}

/** A rule inspects one candidate (plus, for a few, its live DOM element) and
 * returns zero or more hits. See docs/ARCHITECTURE.md 4.5 for the full table
 * of eight rules this module implements. */
export type Rule = (candidate: Candidate, el: Element) => RuleHit[];
