import type { Finding, SnippetResult } from "./api/classify";
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
};

function describeRule(rule: string, label: Label): string {
  return RULE_DESCRIPTIONS[rule] ?? LABEL_DESCRIPTIONS[label] ?? "";
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
 *   4. Never suppress either side; both are reported with provenance.
 */
export function mergeFindings(
  ruleHits: RuleHit[],
  modelResult: SnippetResult | undefined,
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
