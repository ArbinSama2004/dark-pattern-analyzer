import { describe, expect, it } from "vitest";
import {
  mergeFindings,
  modelFindingAllowed,
  withheldModelFindings,
  type CandidateContext,
} from "./merge";
import type { SnippetResult } from "./api/classify";

function modelResult(...labels: string[]): SnippetResult {
  return {
    snippet_id: "s",
    ref: "r",
    benign: false,
    benign_score: 0.1,
    scores: null,
    cached: false,
    findings: labels.map((label) => ({
      label,
      score: 0.7,
      threshold: 0.5,
      confidence: "possible" as const,
      source: ["model" as const],
      description: "",
    })),
  };
}

function context(overrides: Partial<CandidateContext> = {}): CandidateContext {
  return { field: "unknown", role: "body", text: "", ...overrides };
}

/**
 * These are the two places the extension is allowed to withhold something the
 * model returned. Both exist because the model is handed one string and told
 * its tag and role -- it cannot know the string is a seller's product title or
 * a support line in a footer.
 */
describe("modelFindingAllowed", () => {
  const finding = modelResult("forced_action").findings[0]!;

  it("withholds a model finding on a product title", () => {
    // Seller copy. Rules already refuse to fire on a title; the model was
    // still free to, and did -- a Fitbit accessory title came back
    // `forced_action` on a real page.
    expect(modelFindingAllowed(finding, context({ field: "title", role: "body" }))).toBe(
      false,
    );
  });

  it("still reports a finding on a heading, even though headings type as titles", () => {
    // Deliberate limit. inferField types every h1-h6 as a title, and a modal's
    // heading ("Wait! Don't miss out") is exactly what this project exists to
    // flag. Losing those would cost far more than the review-headline false
    // positives it would clean up.
    expect(
      modelFindingAllowed(finding, context({ field: "title", role: "heading" })),
    ).toBe(true);
  });

  it("withholds obstruction on a support line that is not about cancelling", () => {
    // Measured in two languages on real pages: "Visit the help section or
    // contact us" (Amazon) and "you can call us for any help" (Jeevee), both
    // `obstruction`. The model learned the cancel-by-phone pattern and reads
    // any "call us" as it.
    const obstruction = modelResult("obstruction").findings[0]!;

    expect(
      modelFindingAllowed(
        obstruction,
        context({ role: "support_link", text: "Visit the help section or contact us" }),
      ),
    ).toBe(false);
  });

  it("still reports obstruction when the support line is about cancelling", () => {
    // The genuine pattern: you must leave the interface to undo something.
    const obstruction = modelResult("obstruction").findings[0]!;

    expect(
      modelFindingAllowed(
        obstruction,
        context({ role: "support_link", text: "Call us to cancel your subscription" }),
      ),
    ).toBe(true);
    expect(
      modelFindingAllowed(
        obstruction,
        context({ role: "support_link", text: "सदस्यता रद्द गर्न हामीलाई कल गर्नुहोस्" }),
      ),
    ).toBe(true);
  });

  it("says nothing about other labels on a support line", () => {
    // Scoped to obstruction alone -- a support link can carry other patterns,
    // and this policy has no opinion on them.
    const confirmshaming = modelResult("confirmshaming").findings[0]!;

    expect(
      modelFindingAllowed(
        confirmshaming,
        context({ role: "support_link", text: "contact us" }),
      ),
    ).toBe(true);
  });
});

describe("mergeFindings with context", () => {
  it("keeps every model finding when no context is supplied", () => {
    expect(mergeFindings([], modelResult("forced_action"))).toHaveLength(1);
  });

  it("drops a withheld model finding entirely, not just its confidence", () => {
    const merged = mergeFindings([], modelResult("forced_action"), {
      field: "title",
      role: "body",
      text: "HQzon 2-Pack Clip Holder Compatible with Fitbit Inspire 2",
    });

    expect(merged).toEqual([]);
  });

  it("never withholds a rule hit -- the policies apply to the model only", () => {
    // A rule that fired has already been through its own field gate
    // (rules/index.ts). Filtering it again here would apply two different
    // policies to one decision.
    const merged = mergeFindings([{ rule: "prechecked_optin", label: "sneaking" }], undefined, {
      field: "title",
      role: "body",
      text: "anything",
    });

    expect(merged.map((f) => f.label)).toEqual(["sneaking"]);
  });
});

describe("withheldModelFindings", () => {
  it("reports what was withheld and why", () => {
    // The audit trail. Without this, a suppressed finding is
    // indistinguishable in the trace from one the model never made -- which
    // is the unauditable failure this project keeps paying for.
    const withheld = withheldModelFindings(modelResult("forced_action"), {
      field: "title",
      role: "body",
      text: "HQzon 2-Pack Clip Holder Compatible with Fitbit Inspire 2",
    });

    expect(withheld).toHaveLength(1);
    expect(withheld[0]!.label).toBe("forced_action");
    expect(withheld[0]!.reason).toMatch(/product title/);
  });

  it("reports nothing when nothing was refused", () => {
    expect(withheldModelFindings(modelResult("scarcity"), context())).toEqual([]);
  });

  it("agrees with modelFindingAllowed by construction", () => {
    // Both read the same function, so they cannot drift -- asserted rather
    // than assumed, because two policies that "obviously" agree is exactly
    // how the stock_counter contradiction survived for weeks.
    const ctx = context({ role: "support_link", text: "contact us" });
    const result = modelResult("obstruction", "scarcity");

    const withheldLabels = withheldModelFindings(result, ctx).map((w) => w.label);
    const allowedLabels = result.findings
      .filter((f) => modelFindingAllowed(f, ctx))
      .map((f) => f.label);

    expect(withheldLabels).toEqual(["obstruction"]);
    expect(allowedLabels).toEqual(["scarcity"]);
  });
});
