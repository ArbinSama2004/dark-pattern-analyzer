import { describe, expect, it, afterEach } from "vitest";
import { extractCandidates } from "./extract";

/**
 * jsdom does not implement layout, so `offsetParent` is always null
 * regardless of real visibility -- these tests stub it the same way
 * cta_asymmetry.test.ts stubs getBoundingClientRect, to reflect what a real
 * Chrome layout engine would report.
 */
function stubOffsetParent(el: HTMLElement, value: Element | null) {
  Object.defineProperty(el, "offsetParent", {
    configurable: true,
    get: () => value,
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("extractCandidates visibility handling", () => {
  it("does not drop position:fixed elements (cookie banners, modals)", async () => {
    // Regression test: offsetParent is null for display:none AND for
    // position:fixed alike. The old isVisible() treated offsetParent ===
    // null as "hidden" unconditionally, which silently discarded fixed
    // cookie banners and modals while still reporting a healthy extraction
    // count -- no error anywhere.
    //
    // In a real browser, offsetParent is null specifically for an element
    // that is *itself* position:fixed (a descendant's offsetParent resolves
    // to that fixed ancestor, not null) -- so the banner text itself needs
    // to be the fixed element's own direct text, matching how a real cookie
    // banner is usually one fixed div with its own copy.
    document.body.innerHTML = `
      <div id="banner" style="position: fixed; top: 0;">We use cookies to improve your experience on this site</div>
    `;
    const banner = document.getElementById("banner") as HTMLElement;
    stubOffsetParent(banner, null);

    const candidates = await extractCandidates("en");
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain("We use cookies to improve your experience on this site");
  });

  it("still drops genuinely hidden (display:none) elements", async () => {
    document.body.innerHTML = `
      <div id="hidden" style="display: none;">
        <p>This should never be extracted</p>
      </div>
    `;
    const hidden = document.getElementById("hidden") as HTMLElement;
    const p = hidden.querySelector("p") as HTMLElement;
    stubOffsetParent(hidden, null);
    stubOffsetParent(p, null);

    const candidates = await extractCandidates("en");
    const texts = candidates.map((c) => c.text);
    expect(texts).not.toContain("This should never be extracted");
  });

  it("extracts ordinary in-flow visible text", async () => {
    document.body.innerHTML = `<p id="stock">Only 2 left in stock!</p>`;
    const p = document.getElementById("stock") as HTMLElement;
    // In-flow, non-fixed elements do have a real offsetParent (typically
    // <body>) in a real browser -- stub that, not null, to reflect it.
    stubOffsetParent(p, document.body);

    const candidates = await extractCandidates("en");
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain("Only 2 left in stock!");
  });

  it("drops an in-flow element hidden via an ancestor with display:none", async () => {
    // A non-fixed element nested inside a display:none ancestor: offsetParent
    // is null here for the ordinary display:none reason, not the
    // position:fixed exception, so it should still be dropped.
    document.body.innerHTML = `
      <div style="display: none;">
        <p id="nested">Nested hidden text</p>
      </div>
    `;
    const p = document.getElementById("nested") as HTMLElement;
    stubOffsetParent(p, null);

    const candidates = await extractCandidates("en");
    const texts = candidates.map((c) => c.text);
    expect(texts).not.toContain("Nested hidden text");
  });
});
