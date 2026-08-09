import { describe, expect, it } from "vitest";
import { isInStickyChrome, stickyChromeAncestor } from "./sticky";

/** jsdom's getBoundingClientRect always reports zeros, which satisfies the
 * "pinned near the top, shorter than 40% of the viewport" geometry check --
 * so these tests exercise the position + semantics half of the predicate. */
function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe("stickyChromeAncestor", () => {
  it("flags text inside a fixed <header>", () => {
    const body = mount(
      `<header style="position: fixed"><a id="target">Returns &amp; Orders</a></header>`,
    );
    const target = body.querySelector("#target")!;
    expect(stickyChromeAncestor(target)?.tagName).toBe("HEADER");
  });

  it("flags a sticky navbar identified only by its id", () => {
    const body = mount(
      `<div id="navbar" style="position: sticky"><span id="target">Cancel</span></div>`,
    );
    expect(isInStickyChrome(body.querySelector("#target")!)).toBe(true);
  });

  it("flags a sticky container identified only by a class token", () => {
    const body = mount(
      `<div class="site-header shadow" style="position: sticky"><span id="target">Help</span></div>`,
    );
    expect(isInStickyChrome(body.querySelector("#target")!)).toBe(true);
  });

  it("ignores a header that is not fixed or sticky", () => {
    const body = mount(`<header><a id="target">Returns &amp; Orders</a></header>`);
    expect(isInStickyChrome(body.querySelector("#target")!)).toBe(false);
  });

  it("leaves non-nav fixed elements alone -- cookie banners must still be extracted", () => {
    const body = mount(
      `<div class="cookie-consent" style="position: fixed"><p id="target">Accept all cookies</p></div>`,
    );
    expect(isInStickyChrome(body.querySelector("#target")!)).toBe(false);
  });

  it("leaves a fixed modal alone even when it contains a nav landmark", () => {
    const body = mount(
      `<div class="modal-overlay" style="position: fixed"><p id="target">Only 2 left in stock</p></div>`,
    );
    expect(isInStickyChrome(body.querySelector("#target")!)).toBe(false);
  });

  it("returns null for ordinary in-flow content", () => {
    const body = mount(`<div class="product"><p id="target">Hurry, 3 left!</p></div>`);
    expect(stickyChromeAncestor(body.querySelector("#target")!)).toBeNull();
  });
});
