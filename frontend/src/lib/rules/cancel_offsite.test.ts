import { describe, expect, it, afterEach } from "vitest";
import { cancelOffsite } from "./cancel_offsite";
import { makeCandidate } from "./test-helpers";

function anchor(href: string): HTMLAnchorElement {
  const el = document.createElement("a");
  el.setAttribute("href", href);
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("cancelOffsite rule", () => {
  it("fires on a mailto: cancel link", () => {
    const hits = cancelOffsite(
      makeCandidate({ role: "decline" }),
      anchor("mailto:support@example.com?subject=cancel"),
    );
    expect(hits).toEqual([{ rule: "cancel_offsite", label: "obstruction" }]);
  });

  it("fires on a tel: cancel link", () => {
    const hits = cancelOffsite(
      makeCandidate({ role: "decline" }),
      anchor("tel:+15551234567"),
    );
    expect(hits).toEqual([{ rule: "cancel_offsite", label: "obstruction" }]);
  });

  it("fires on an external-domain cancel link", () => {
    const hits = cancelOffsite(
      makeCandidate({ role: "decline" }),
      anchor("https://third-party-retention.example/cancel"),
    );
    expect(hits).toEqual([{ rule: "cancel_offsite", label: "obstruction" }]);
  });

  it("does not fire on a same-origin, in-app cancel link", () => {
    const el = anchor("/account/cancel");
    const hits = cancelOffsite(makeCandidate({ role: "decline" }), el);
    expect(hits).toEqual([]);
  });

  it("does not fire on a non-decline role", () => {
    const hits = cancelOffsite(
      makeCandidate({ role: "cta" }),
      anchor("mailto:sales@example.com"),
    );
    expect(hits).toEqual([]);
  });
});
