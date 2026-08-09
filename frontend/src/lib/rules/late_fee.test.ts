import { describe, expect, it } from "vitest";
import { lateFee } from "./late_fee";
import { makeCandidate } from "./test-helpers";

describe("lateFee rule", () => {
  it("fires on a service fee line at the payment step", () => {
    const hits = lateFee(
      makeCandidate({ role: "line_item", step: "payment", text: "Service fee: $4.99" }),
      document.body,
    );
    expect(hits).toEqual([{ rule: "late_fee", label: "sneaking" }]);
  });

  it("does not fire on the same fee wording at the cart step", () => {
    const hits = lateFee(
      makeCandidate({ role: "line_item", step: "cart", text: "Service fee: $4.99" }),
      document.body,
    );
    expect(hits).toEqual([]);
  });

  it("does not fire on an ordinary payment-step line item", () => {
    const hits = lateFee(
      makeCandidate({ role: "line_item", step: "payment", text: "Subtotal: $49.00" }),
      document.body,
    );
    expect(hits).toEqual([]);
  });

  it("does not fire on a non-line_item role", () => {
    const hits = lateFee(
      makeCandidate({ role: "body", step: "payment", text: "Processing fee applies" }),
      document.body,
    );
    expect(hits).toEqual([]);
  });
});
