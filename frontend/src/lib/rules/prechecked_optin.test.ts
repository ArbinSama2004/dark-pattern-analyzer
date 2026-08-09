import { describe, expect, it } from "vitest";
import { precheckedOptin } from "./prechecked_optin";
import { makeCandidate } from "./test-helpers";

function checkbox(labelText: string, checked: boolean): HTMLInputElement {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  label.appendChild(input);
  label.appendChild(document.createTextNode(labelText));
  document.body.appendChild(label);
  return input;
}

describe("precheckedOptin rule", () => {
  it("fires on a checked box whose label mentions email marketing", () => {
    const el = checkbox("Send me email offers and updates", true);
    const hits = precheckedOptin(
      makeCandidate({ role: "checkbox", checked: true }),
      el,
    );
    expect(hits).toEqual([{ rule: "prechecked_optin", label: "sneaking" }]);
    el.closest("label")?.remove();
  });

  it("does not fire when the box starts unchecked", () => {
    const el = checkbox("Subscribe to our newsletter", false);
    const hits = precheckedOptin(
      makeCandidate({ role: "checkbox", checked: false }),
      el,
    );
    expect(hits).toEqual([]);
    el.closest("label")?.remove();
  });

  it("does not fire on a checked box unrelated to marketing consent", () => {
    const el = checkbox("I confirm I am over 18", true);
    const hits = precheckedOptin(
      makeCandidate({ role: "checkbox", checked: true }),
      el,
    );
    expect(hits).toEqual([]);
    el.closest("label")?.remove();
  });

  it("does not fire on a non-checkbox role", () => {
    const el = checkbox("Subscribe via email", true);
    const hits = precheckedOptin(makeCandidate({ role: "cta", checked: true }), el);
    expect(hits).toEqual([]);
    el.closest("label")?.remove();
  });
});
