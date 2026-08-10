import { describe, expect, it } from "vitest";
import { forcedActionGate } from "./forced_action_gate";
import { makeCandidate } from "./test-helpers";
import { mergeFindings } from "../merge";
import type { SnippetResult } from "../api/classify";

describe("forcedActionGate rule", () => {
  it("genuine forced interaction: a required form field whose own text states the dependency", () => {
    const hits = forcedActionGate(
      makeCandidate({
        role: "form_gate",
        text: "Enter your phone number to continue",
      }),
      document.body,
    );
    expect(hits).toEqual([{ rule: "forced_action_gate", label: "forced_action" }]);
  });

  it("genuine forced interaction: modal text stating the gate explicitly", () => {
    const hits = forcedActionGate(
      makeCandidate({ role: "modal_text", text: "Sign in to continue" }),
      document.body,
    );
    expect(hits).toEqual([{ rule: "forced_action_gate", label: "forced_action" }]);
  });

  it("required action versus optional action: a required field with ordinary wording does not fire", () => {
    // role=form_gate alone (role.ts already requires an actually-`required`
    // input inside a <form> for this role) is not sufficient by itself --
    // the text must also assert the dependency.
    const hits = forcedActionGate(
      makeCandidate({ role: "form_gate", text: "Phone number" }),
      document.body,
    );
    expect(hits).toEqual([]);
  });

  it("modal without forced interaction: modal text with unrelated wording does not fire", () => {
    const hits = forcedActionGate(
      makeCandidate({ role: "modal_text", text: "Free shipping on orders over $50" }),
      document.body,
    );
    expect(hits).toEqual([]);
  });

  it("form without forced interaction: dependency wording outside a gated role does not fire", () => {
    // Not "if a form exists" -- role must actually be form_gate or
    // modal_text. Ordinary body text using similar wording elsewhere on the
    // page must not trigger this.
    const hits = forcedActionGate(
      makeCandidate({ role: "body", text: "Add a note to continue your order" }),
      document.body,
    );
    expect(hits).toEqual([]);
  });

  it("normal CTA incorrectly resembling forced_action: a cta-role button with similar wording does not fire", () => {
    const hits = forcedActionGate(
      makeCandidate({ role: "cta", text: "Continue to checkout" }),
      document.body,
    );
    expect(hits).toEqual([]);
  });

  it("does not fire on other gated-sounding roles outside the allowlist", () => {
    const hits = forcedActionGate(
      makeCandidate({ role: "toast", text: "You must verify your email to continue" }),
      document.body,
    );
    expect(hits).toEqual([]);
  });
});

describe("forcedActionGate + mergeFindings integration (the corroboration contract)", () => {
  // These exercise the *existing* merge policy (merge.ts), unmodified by
  // this fix -- the point of Part B is that no new confidence/flagging
  // mechanism was needed, only a rule to feed the existing one.

  function modelForcedAction(score = 0.56): SnippetResult {
    return {
      snippet_id: "x",
      ref: "x",
      benign: false,
      benign_score: 0.06,
      scores: null,
      cached: false,
      findings: [
        {
          label: "forced_action",
          score,
          threshold: 0.43,
          confidence: "possible",
          source: ["model"],
          description: "Requires an unrelated action to proceed, such as signing up.",
        },
      ],
    };
  }

  it("model forced_action WITH strong structural evidence -> upgraded to likely", () => {
    const candidate = makeCandidate({ role: "form_gate", text: "Enter your phone number to continue" });
    const ruleHits = forcedActionGate(candidate, document.body);

    const merged = mergeFindings(ruleHits, modelForcedAction());

    expect(merged).toEqual([
      expect.objectContaining({
        label: "forced_action",
        confidence: "likely",
        source: expect.arrayContaining(["model", "rule"]),
      }),
    ]);
  });

  it("model forced_action WITHOUT supporting evidence -> stays possible (the existing 'flag for investigation' signal)", () => {
    const candidate = makeCandidate({ role: "cta", text: "Continue" });
    const ruleHits = forcedActionGate(candidate, document.body);
    expect(ruleHits).toEqual([]); // no structural corroboration

    const merged = mergeFindings(ruleHits, modelForcedAction());

    // Retained, not suppressed or silently reclassified -- just left at the
    // confidence level the architecture already uses to mean "model-only".
    expect(merged).toEqual([
      expect.objectContaining({
        label: "forced_action",
        confidence: "possible",
        source: ["model"],
      }),
    ]);
  });

  it("rule fires without model agreement -> likely on its own merit, same as every other rule", () => {
    const candidate = makeCandidate({ role: "modal_text", text: "Sign in to continue" });
    const ruleHits = forcedActionGate(candidate, document.body);

    const merged = mergeFindings(ruleHits, undefined);

    expect(merged).toEqual([
      expect.objectContaining({
        label: "forced_action",
        confidence: "likely",
        source: ["rule"],
      }),
    ]);
  });
});
