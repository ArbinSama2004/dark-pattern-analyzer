import { describe, expect, it, afterEach } from "vitest";
import { extractCandidates, extractCandidatesWithElements } from "./extract";

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

describe("extractCandidatesWithElements occurrence identity (Fix 1)", () => {
  it("keeps three identical-text buttons as three independently addressable candidates", async () => {
    // The exact regression this fix targets: Product A/B/C each have their
    // own "Add to Cart" button. Before Fix 1, candidate.id was
    // sha1(lang+text) alone, so only the first of these three ever became a
    // candidate at all -- the other two were silently dropped in extract.ts's
    // `seen` dedupe, before role inference even ran on them.
    document.body.innerHTML = `
      <div id="product-a"><button>Add to Cart</button></div>
      <div id="product-b"><button>Add to Cart</button></div>
      <div id="product-c"><button>Add to Cart</button></div>
    `;
    for (const btn of document.querySelectorAll("button")) {
      Object.defineProperty(btn, "offsetParent", {
        configurable: true,
        get: () => document.body,
      });
    }

    const pairs = await extractCandidatesWithElements("en");
    const addToCart = pairs.filter((p) => p.candidate.text === "Add to Cart");

    expect(addToCart).toHaveLength(3);
    // Distinct occurrence ids...
    expect(new Set(addToCart.map((p) => p.candidate.id)).size).toBe(3);
    // ...each pointing at its own physical element, not one shared node.
    expect(new Set(addToCart.map((p) => p.el))).toEqual(
      new Set([
        document.querySelector("#product-a button"),
        document.querySelector("#product-b button"),
        document.querySelector("#product-c button"),
      ]),
    );
  });

  it("still produces exactly one candidate for a single physical button", async () => {
    // Sanity check that the `seen` guard still does its narrower job: a
    // single walk of the document never visits the same node twice, so this
    // is really asserting extraction doesn't fabricate duplicates out of one
    // element on a plain page. Wrapped in a div (not one of extract.ts's
    // INLINE_TAGS) so `document.body` itself doesn't also qualify as a
    // leaf-block candidate via its own text-coalescing heuristic -- that's a
    // real, separate two-different-elements case, not what this test is for.
    document.body.innerHTML = `<div id="only-wrap"><button id="only">Add to Cart</button></div>`;
    Object.defineProperty(document.getElementById("only"), "offsetParent", {
      configurable: true,
      get: () => document.body,
    });

    const pairs = await extractCandidatesWithElements("en");
    const addToCart = pairs.filter((p) => p.candidate.text === "Add to Cart");
    expect(addToCart).toHaveLength(1);
    expect(addToCart[0]?.el).toBe(document.getElementById("only"));
  });
});

describe("extractCandidatesWithElements self-duplicate collapsing", () => {
  it("collapses a CSS hover/flip duplicate down to one copy", async () => {
    // Reproduces a real pattern found via a live Amazon trace: a label
    // rendered twice back-to-back with no separator, for a CSS hover/flip
    // animation that swaps between them via transform/overflow clipping --
    // not display/visibility/opacity, so isVisible() sees both copies as
    // visible. The outer div here is the leaf-block candidate; its one
    // inline child's own nested content is already the doubled string.
    document.body.innerHTML = `
      <div id="card">
        <span><span>Discover more</span><span>Discover more</span></span>
      </div>
    `;
    stubOffsetParent(document.getElementById("card") as HTMLElement, document.body);

    const candidates = await extractCandidates("en");
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain("Discover more");
    expect(texts).not.toContain("Discover moreDiscover more");
  });

  it("does not collapse a whole-string repeat below the minimum half-length", async () => {
    // Guard against over-eager collapsing: "abcabc" is a genuine T+T repeat
    // (half = "abc" = "abc"), but at half-length 3 -- below
    // MIN_DUPLICATE_HALF_LENGTH -- a naive "does the first half equal the
    // second half" check with no length floor would wrongly mangle this
    // kind of short coincidental repeat, so it must survive intact.
    document.body.innerHTML = `<p id="p">abcabc</p>`;
    stubOffsetParent(document.getElementById("p") as HTMLElement, document.body);

    const candidates = await extractCandidates("en");
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain("abcabc");
  });

  it("does not alter text that merely starts with a repeated substring", async () => {
    document.body.innerHTML = `<p id="p">Free shipping on all orders today</p>`;
    stubOffsetParent(document.getElementById("p") as HTMLElement, document.body);

    const candidates = await extractCandidates("en");
    const texts = candidates.map((c) => c.text);
    expect(texts).toContain("Free shipping on all orders today");
  });
});

describe("nested duplicate collapsing", () => {
  /** Every element in the fixture reports a real offsetParent, so isVisible()
   * behaves as it would under a browser layout engine. */
  function makeEverythingVisible() {
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      stubOffsetParent(el as HTMLElement, document.body);
    }
  }

  it("emits one candidate when a block wraps a single inline node", async () => {
    // The shape that produced two badges on one string: the div has no direct
    // text, so leafBlockText coalesces the span and emits the same words a
    // second time under a different selector.
    document.body.innerHTML = `<div class="sold"><span>958 sold</span></div>`;
    makeEverythingVisible();

    const candidates = await extractCandidates("en");

    expect(candidates.filter((c) => c.text === "958 sold")).toHaveLength(1);
  });

  it("keeps the innermost element, so a badge is not anchored to an image", async () => {
    // <img> is an inline tag, so this card link qualifies as a leaf block: its
    // candidate text is the title but its box spans the image. Anchoring
    // there is what outlined an entire product image on click.
    document.body.innerHTML = `
      <a href="/p/1" class="card"><img src="x.jpg" alt=""><span class="title">Wireless Earbuds</span></a>`;
    makeEverythingVisible();

    const pairs = await extractCandidatesWithElements("en");
    const title = pairs.filter((p) => p.candidate.text === "Wireless Earbuds");

    expect(title).toHaveLength(1);
    expect(title[0]!.el.tagName.toLowerCase()).toBe("span");
    expect(title[0]!.el.querySelector("img")).toBeNull();
  });

  it("carries the wrapper's role down to the element it keeps", async () => {
    // The class that identifies this text lives on the wrapper; the inline
    // child has nothing to infer from and falls back to "body". Role is part
    // of the model input string, so dropping the wrapper must not change what
    // the model is asked.
    document.body.innerHTML = `<div class="stock-info"><span>Only 3 items left</span></div>`;
    makeEverythingVisible();

    const candidates = await extractCandidates("en");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.role).toBe("stock");
  });

  it("prefers the closest wrapper's role over a more distant one", async () => {
    document.body.innerHTML = `
      <div class="promo-wrap"><div class="stock-info"><span>Only 3 items left</span></div></div>`;
    makeEverythingVisible();

    const candidates = await extractCandidates("en");

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.role).toBe("stock");
  });

  it("keeps a joined string alongside the children it was built from", async () => {
    // Narrow by design: only *identical* text collapses. The joined price
    // comparison is a string no child carries, and it is the thing worth
    // judging -- collapsing it away would lose the only candidate that shows
    // the original and the sale price together.
    document.body.innerHTML = `<div class="price"><s>Rs. 2,499</s><span>Rs. 1,199</span></div>`;
    makeEverythingVisible();

    const texts = (await extractCandidates("en")).map((c) => c.text);

    expect(texts).toContain("Rs. 2,499 Rs. 1,199");
    expect(texts).toContain("Rs. 2,499");
    expect(texts).toContain("Rs. 1,199");
  });

  it("keeps both occurrences when the wrapper has text of its own", async () => {
    // Renders as "Hello Hello": two real occurrences, not an extraction
    // artifact. Only a wrapper with no text of its own is a duplicate.
    document.body.innerHTML = `<div id="outer">Hello<span>Hello</span></div>`;
    makeEverythingVisible();

    const candidates = await extractCandidates("en");

    expect(candidates.filter((c) => c.text === "Hello")).toHaveLength(2);
  });

  it("keeps the same text appearing in two separate cards", async () => {
    // Sibling occurrences are distinct findings on distinct products; only a
    // containment relationship makes two candidates the same words.
    document.body.innerHTML = `
      <div class="a"><span>Only 3 items left</span></div>
      <div class="b"><span>Only 3 items left</span></div>`;
    makeEverythingVisible();

    const candidates = await extractCandidates("en");

    expect(candidates.filter((c) => c.text === "Only 3 items left")).toHaveLength(2);
  });

  it("collapses a three-level chain down to one candidate", async () => {
    document.body.innerHTML = `<div class="outer"><div class="mid"><span>958 sold</span></div></div>`;
    makeEverythingVisible();

    const pairs = await extractCandidatesWithElements("en");

    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.el.tagName.toLowerCase()).toBe("span");
  });
});
