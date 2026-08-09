import { describe, expect, it } from "vitest";
import { hiddenOptout } from "./hidden_optout";
import { makeCandidate } from "./test-helpers";

function el(opacity?: string): HTMLElement {
  const node = document.createElement("button");
  if (opacity) node.style.opacity = opacity;
  document.body.appendChild(node);
  return node;
}

describe("hiddenOptout rule", () => {
  it("fires on a decline control with a tiny font", () => {
    const hits = hiddenOptout(
      makeCandidate({ role: "decline", font_px: 8, contrast: 5 }),
      el(),
    );
    expect(hits.map((h) => h.rule)).toEqual(["hidden_optout", "hidden_optout"]);
    expect(hits.map((h) => h.label)).toEqual(["sneaking", "obstruction"]);
  });

  it("fires on a decline control with low contrast", () => {
    const hits = hiddenOptout(
      makeCandidate({ role: "decline", font_px: 14, contrast: 1.5 }),
      el(),
    );
    expect(hits.length).toBe(2);
  });

  it("fires on a decline control with low opacity", () => {
    const hits = hiddenOptout(
      makeCandidate({ role: "decline", font_px: 14, contrast: 5 }),
      el("0.3"),
    );
    expect(hits.length).toBe(2);
  });

  it("does not fire on a clearly readable decline control", () => {
    const hits = hiddenOptout(
      makeCandidate({ role: "decline", font_px: 14, contrast: 6 }),
      el("1"),
    );
    expect(hits).toEqual([]);
  });

  it("does not fire on a non-decline role, even if faint", () => {
    const hits = hiddenOptout(
      makeCandidate({ role: "fine_print", font_px: 8, contrast: 1.5 }),
      el("0.2"),
    );
    expect(hits).toEqual([]);
  });
});
