import type { Rule } from "./types";

const FEE_KEYWORDS: Record<string, RegExp> = {
  en: /\b(service fee|processing fee|handling fee|convenience fee|surcharge)\b/i,
  hi: /(सेवा शुल्क|प्रोसेसिंग शुल्क|अतिरिक्त शुल्क)/,
  ne: /(सेवा शुल्क|प्रशोधन शुल्क|थप शुल्क)/,
};

/**
 * A new charge line appearing at the payment step. See docs/ARCHITECTURE.md
 * 4.5: "new price line appears at step=payment absent at step=cart".
 *
 * Scoping note: a true implementation of that spec needs to diff the set of
 * price lines seen at step=cart against step=payment across a session --
 * state this per-candidate rule signature doesn't carry (background.ts's
 * session cache tracks classification results by hash, not a structured
 * per-page price-line history). This implementation approximates it with a
 * same-session heuristic: it fires on a line_item at step=payment whose text
 * matches fee wording, which is the visible symptom the full diff would
 * catch, without the cross-step bookkeeping. A cart-step fee that's simply
 * carried through unchanged to payment is a false positive this
 * approximation accepts -- flagged here rather than silently claimed as the
 * full spec.
 */
export const lateFee: Rule = (candidate) => {
  if (candidate.role !== "line_item" || candidate.step !== "payment") return [];

  const pattern = FEE_KEYWORDS[candidate.lang] ?? FEE_KEYWORDS.en;
  if (!pattern?.test(candidate.text)) return [];

  return [{ rule: "late_fee", label: "sneaking" }];
};
