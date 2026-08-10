import type { Rule } from "./types";

/**
 * Fix 4, Part B: structural corroboration for `forced_action`.
 *
 * No rule previously emitted this label -- every `forced_action` finding was
 * model-only (`source: ["model"]`, `confidence: "possible"`), with nothing
 * in the existing merge policy (merge.ts) able to upgrade it the way a rule
 * agreement upgrades every other label. This rule supplies that missing
 * input; it does not add any new confidence/flagging mechanism, because the
 * existing one already does exactly what's needed:
 *
 *   - model says forced_action AND this rule agrees -> mergeFindings
 *     upgrades to "likely" (case 1: rule + model agree).
 *   - model says forced_action AND this rule does NOT fire -> stays
 *     "possible" (case 3: model-only) -- which *is* this system's existing
 *     "flag for investigation" signal; nothing new needed for that case.
 *   - this rule fires without the model agreeing -> "likely" on its own
 *     merit (case 2), the same as every other structural rule in this file
 *     (cancel_offsite, hidden_optout, ...): structural evidence is trusted
 *     independently, not only as a tiebreaker.
 *
 * Deliberately NOT "if a modal exists" or "if a form exists" alone -- both
 * explicitly named as too broad. Two independent signals are required
 * together, neither sufficient on its own:
 *
 *   1. A structural gate: role.ts already computes `form_gate` only for an
 *      actually-`required` input/select/textarea inside a `<form>` (a real
 *      mandatory field, not "a form exists somewhere"), and `modal_text`
 *      only for text whose own ancestor is a dialog/modal container (not
 *      "a modal exists on the page"). Both are already narrow by
 *      construction, from work role.ts already does for other reasons.
 *   2. Explicit blocking/dependency wording IN THE CANDIDATE'S OWN TEXT --
 *      "to continue", "required to", "you must", and language equivalents.
 *      This is what "reason about whether the interaction is actually
 *      necessary or blocking" means in practice here: the text has to
 *      assert the gate itself, not merely sit near one.
 *
 * A required checkbox with ordinary wording, or a modal containing an
 * unrelated sentence, satisfies only one signal and does not fire.
 */
const DEPENDENCY_KEYWORDS: Record<string, RegExp> = {
  en: /\b(to continue|to proceed|to unlock|required to|you must|in order to)\b/i,
  hi: /(जारी रखने के लिए|आगे बढ़ने के लिए|अनिवार्य है)/,
  ne: /(जारी राख्न|अगाडि बढ्न|अनिवार्य छ)/,
};

const GATED_ROLES = new Set(["form_gate", "modal_text"]);

export const forcedActionGate: Rule = (candidate) => {
  if (!GATED_ROLES.has(candidate.role)) return [];

  const pattern = DEPENDENCY_KEYWORDS[candidate.lang] ?? DEPENDENCY_KEYWORDS.en;
  if (!pattern?.test(candidate.text)) return [];

  return [{ rule: "forced_action_gate", label: "forced_action" }];
};
