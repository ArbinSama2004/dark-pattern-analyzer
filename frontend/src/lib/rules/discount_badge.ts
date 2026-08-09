import type { Rule } from "./types";

/**
 * Fires `false_urgency` when a candidate's text is an artificially prominent
 * discount badge (e.g. "-8%", "15% off", "Save NPR 300"). These are common
 * on Daraz and other e-commerce sites to create urgency through exaggerated
 * or artificial discounts.
 *
 * The rule fires on the `"promo"` role only (set by role.ts's DISCOUNT_TEXT_RE
 * branch) so generic percentage text in body copy (e.g. "98% of customers
 * were satisfied") doesn't trigger it.
 *
 * This complements the model: the rule fires immediately as a "rule-only"
 * hit (confidence "likely") without waiting for the batch-inference round
 * trip, and the merge policy (merge.ts) upgrades it to "rule+model likely"
 * if the model also fires.
 */
const DISCOUNT_BADGE_RE = /^-\d+%$|^\d+%\s*off\b|\bsave\s+[\d,]+|\bsave\s+\d+%/i;

export const discountBadge: Rule = (candidate) => {
  // Only fire for elements already inferred as promotional (either by class
  // name or by text content, per role.ts). This avoids tagging incidental
  // percentage mentions in body text.
  if (candidate.role !== "promo") return [];
  if (!DISCOUNT_BADGE_RE.test(candidate.text)) return [];
  return [{ rule: "discount_badge", label: "false_urgency" }];
};
