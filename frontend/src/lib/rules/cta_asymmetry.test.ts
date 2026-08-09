import { describe, expect, it, afterEach } from "vitest";
import { ctaAsymmetry } from "./cta_asymmetry";
import { makeCandidate } from "./test-helpers";

function stubRect(el: HTMLElement, width: number, height: number) {
  el.getBoundingClientRect = () =>
    ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON() {
        return this;
      },
    }) as DOMRect;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ctaAsymmetry rule", () => {
  it("fires when the accept button is more than 3x the decline button's area", () => {
    const container = document.createElement("div");
    const accept = document.createElement("button");
    const decline = document.createElement("button");
    container.appendChild(accept);
    container.appendChild(decline);
    document.body.appendChild(container);

    stubRect(accept, 200, 50); // area 10,000
    stubRect(decline, 40, 20); // area 800 -> ratio 12.5

    const hits = ctaAsymmetry(makeCandidate({ role: "decline" }), decline);
    expect(hits).toEqual([{ rule: "cta_asymmetry", label: "obstruction" }]);
  });

  it("does not fire when the buttons are comparably sized", () => {
    const container = document.createElement("div");
    const accept = document.createElement("button");
    const decline = document.createElement("button");
    container.appendChild(accept);
    container.appendChild(decline);
    document.body.appendChild(container);

    stubRect(accept, 100, 40);
    stubRect(decline, 90, 40);

    const hits = ctaAsymmetry(makeCandidate({ role: "decline" }), decline);
    expect(hits).toEqual([]);
  });

  it("does not fire on a non-decline role", () => {
    const decline = document.createElement("button");
    document.body.appendChild(decline);
    stubRect(decline, 10, 10);

    const hits = ctaAsymmetry(makeCandidate({ role: "cta" }), decline);
    expect(hits).toEqual([]);
  });

  it("does not fire when no other button is nearby", () => {
    const decline = document.createElement("button");
    document.body.appendChild(decline);
    stubRect(decline, 40, 20);

    const hits = ctaAsymmetry(makeCandidate({ role: "decline" }), decline);
    expect(hits).toEqual([]);
  });
});
