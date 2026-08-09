import { describe, expect, it } from "vitest";
import { stockCounter } from "./stock_counter";
import { makeCandidate } from "./test-helpers";

describe("stockCounter rule", () => {
  it("fires on 'Only N left' in English", () => {
    const hits = stockCounter(makeCandidate({ text: "Only 2 left in stock!" }), document.body);
    expect(hits).toEqual([{ rule: "stock_counter", label: "scarcity" }]);
  });

  it("fires on Hindi 'केवल N बाकी'", () => {
    const hits = stockCounter(makeCandidate({ text: "केवल 3 बाकी हैं" }), document.body);
    expect(hits).toEqual([{ rule: "stock_counter", label: "scarcity" }]);
  });

  it("does not fire on ordinary delivery copy", () => {
    const hits = stockCounter(makeCandidate({ text: "Delivery in 3 days" }), document.body);
    expect(hits).toEqual([]);
  });

  it("does not fire on a verifiable static line (annotation boundary rule 1)", () => {
    // docs/ARCHITECTURE.md 2.2: "Verifiable != dark." This rule is deliberately
    // text-pattern-only and cannot distinguish presentation (pulsing red vs
    // static grey) -- that distinction is a model/annotation concern, not this
    // rule's job. Documented here so the boundary is visible, not silently lost.
    const hits = stockCounter(makeCandidate({ text: "47 units in stock" }), document.body);
    expect(hits).toEqual([]); // doesn't match "only N left" phrasing
  });
});
