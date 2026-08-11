import type { Finding, SnippetResult } from "./api/classify";
import type { Field } from "./extract/types";
import type { RuleHit } from "./rules/types";
import { LABEL_DESCRIPTIONS, type Label } from "./taxonomy";

export type MergedFinding = Finding;

/** Human-readable "why" for a rule-only hit -- the backend supplies its own
 * `description` for model findings, but a rule hit with no model agreement
 * needs its own plain-language explanation (docs/ARCHITECTURE.md 4.3: every
 * finding needs "a plain-language why"). Keyed by rule name, one line each. */
const RULE_DESCRIPTIONS: Record<string, string> = {
  stock_counter: "A shrinking stock count is used to create urgency.",
  countdown_timer: "A countdown timer is used to create urgency.",
  viewer_counter: "A live viewer count is used as social pressure.",
  prechecked_optin: "A marketing consent box starts pre-checked.",
  hidden_optout:
    "The decline option is hard to see (small text, low contrast, or faded out).",
  cta_asymmetry:
    "The accept button is made much more prominent than the decline option.",
  late_fee: "A new charge appears only once you reach the payment step.",
  cancel_offsite:
    "Cancelling routes you off the page (phone/email/another site) instead of handling it here.",
  discount_badge:
    "A discount percentage badge may be inflated or artificial, creating a false sense of savings.",
  forced_action_gate:
    "A required field or modal step explicitly states you must complete it to continue.",
};

function describeRule(rule: string, label: Label): string {
  return RULE_DESCRIPTIONS[rule] ?? LABEL_DESCRIPTIONS[label] ?? "";
}

/** What the extension knows about a candidate that the model was never told.
 * The backend receives only text, tag, role and lang, so any policy that
 * depends on where the text sits on the page has to be applied here. */
export interface CandidateContext {
  field: Field;
  role: string;
  text: string;
}

/**
 * Wording that turns a phone number or a contact link into an obstruction:
 * the user is being made to leave the interface to *undo* something. Without
 * one of these, "call us" is an offer of help.
 *
 * Devanagari included because the misfire was measured in both languages --
 * see modelFindingAllowed.
 */
const CANCELLATION_INTENT_RE =
  /\b(cancel|unsubscribe|refund|terminate|close (my )?account|opt[- ]?out|return)\b|रद्द|फिर्ता|खारेज/i;

/**
 * Should a model finding be shown, given where on the page its text sits?
 *
 * The model is handed one string and told its tag and role; it cannot know that
 * the string is a seller's product title or a support line in a footer. Both of
 * the policies below come from measured misfires on real pages, and both are
 * deliberately narrow -- a model finding is shown unless there is a specific,
 * named reason not to.
 */
export interface WithheldFinding {
  label: string;
  score: number;
  /** Which policy withheld it, in words. Written into the debug trace so a
   * suppressed finding is visible rather than indistinguishable from the model
   * having said nothing. */
  reason: string;
}

/**
 * The reason this model finding must not be shown, or null to show it.
 *
 * Split out from `modelFindingAllowed` so the reason survives to the trace.
 * A policy that drops findings silently is the same unauditable failure this
 * project has paid for repeatedly -- "why is this not flagged?" has to be
 * answerable from a trace, not from reading the source.
 */
export function withholdReason(
  finding: MergedFinding,
  context: CandidateContext,
): string | null {
  // 1. A product title is seller copy. Rules already refuse to fire on one
  //    (rules/index.ts); the model was still free to, and did -- a Fitbit
  //    accessory title came back `forced_action` on a real page.
  //
  //    Headings are excluded from this rule on purpose. `inferField` types
  //    every h1-h6 as a title, and a modal's heading ("Wait! Don't miss out")
  //    is exactly the kind of copy this project exists to flag. The trade is
  //    explicit: two review-headline false positives stay, rather than losing
  //    every dark pattern written as a heading.
  if (context.field === "title" && context.role !== "heading") {
    return "product title -- seller copy, the same policy the rules follow";
  }

  // 2. "Contact us" / "call us" reads to the model as the cancel-by-phone
  //    pattern, because that is what obstruction looked like in training.
  //    Measured on two real pages in two languages: Amazon's "Visit the help
  //    section or contact us" and Jeevee's "कुनै पनि मद्दत को लागी तपाइँ
  //    हामीलाई कल गर्न सक्नुहुन्छ" ("you can call us for any help"), both
  //    `obstruction`, neither about cancelling anything.
  //
  //    Scoped to obstruction alone: a support link really can carry other
  //    patterns, and this says nothing about them.
  if (
    finding.label === "obstruction" &&
    context.role === "support_link" &&
    !CANCELLATION_INTENT_RE.test(context.text)
  ) {
    return "support line with no cancellation wording -- an offer of help, not an obstruction";
  }

  return null;
}

/** True if this model finding may be shown. Thin wrapper over withholdReason,
 * kept because "is this allowed" is what most callers actually ask. */
export function modelFindingAllowed(
  finding: MergedFinding,
  context: CandidateContext,
): boolean {
  return withholdReason(finding, context) === null;
}

/** Model findings that a policy above refused, with their reasons. Computed
 * from the same function that does the refusing, so the two can never drift. */
export function withheldModelFindings(
  modelResult: SnippetResult | undefined,
  context: CandidateContext,
): WithheldFinding[] {
  const withheld: WithheldFinding[] = [];
  for (const finding of modelResult?.findings ?? []) {
    const reason = withholdReason(finding, context);
    if (reason) withheld.push({ label: finding.label, score: finding.score, reason });
  }
  return withheld;
}

/**
 * Combines local rule hits with the backend's model findings for one
 * candidate, per docs/ARCHITECTURE.md 4.5's merge policy:
 *
 *   1. Rule hit + model hit  -> confidence "likely", source ["model","rule"]
 *   2. Rule hit only          -> confidence "likely" (structural evidence
 *                                 outweighs wording -- a timer *is* a timer)
 *   3. Model hit only         -> confidence "possible", as the backend
 *                                 already returned it
 *   4. Neither side suppresses the other; both are reported with provenance.
 *
 * `context` is what the extension knows and the model does not -- see
 * modelFindingAllowed, which is the one place a model finding can be withheld.
 * Omitting it keeps every model finding, which is what the tests of the merge
 * policy itself want.
 */
export function mergeFindings(
  ruleHits: RuleHit[],
  modelResult: SnippetResult | undefined,
  context?: CandidateContext,
): MergedFinding[] {
  const byLabel = new Map<Label, MergedFinding>();

  for (const hit of ruleHits) {
    const existing = byLabel.get(hit.label);
    if (existing) {
      if (!existing.source.includes("rule")) existing.source = [...existing.source, "rule"];
      continue;
    }
    byLabel.set(hit.label, {
      label: hit.label,
      score: 1,
      threshold: 0,
      confidence: "likely",
      source: ["rule"],
      description: describeRule(hit.rule, hit.label),
    });
  }

  for (const finding of modelResult?.findings ?? []) {
    if (context && !modelFindingAllowed(finding, context)) continue;
    const label = finding.label as Label;
    const existing = byLabel.get(label);
    if (existing) {
      // Rule + model agree on this label -> upgrade to "likely", keep the
      // model's richer score/threshold/description, union the provenance.
      byLabel.set(label, {
        ...finding,
        confidence: "likely",
        source: [...new Set([...existing.source, ...finding.source])] as MergedFinding["source"],
      });
    } else {
      byLabel.set(label, finding);
    }
  }

  return [...byLabel.values()].sort((a, b) => b.score - a.score);
}

const SCORE_WEIGHT: Record<MergedFinding["confidence"], number> = {
  likely: 2,
  possible: 1,
};

/**
 * Page score per docs/ARCHITECTURE.md 4.3: "weighted count of findings,
 * normalised to 0-100 and bucketed low/medium/high." Published here (not
 * hidden in a component) since the doc explicitly says an unexplained score
 * isn't defensible in a report.
 *
 * Formula: sum(2 for each "likely" finding, 1 for each "possible" finding)
 * across all candidates, then normalised against a soft cap so a page with
 * many findings saturates toward 100 rather than growing unbounded.
 */
const SATURATION_POINTS = 20;

export function computePageScore(allFindings: MergedFinding[][]): number {
  const raw = allFindings
    .flat()
    .reduce((sum, f) => sum + SCORE_WEIGHT[f.confidence], 0);
  return Math.round(Math.min(1, raw / SATURATION_POINTS) * 100);
}

export function scoreBand(score: number): "low" | "medium" | "high" {
  if (score < 30) return "low";
  if (score < 65) return "medium";
  return "high";
}
