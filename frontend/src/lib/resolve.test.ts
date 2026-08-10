import { describe, expect, it, afterEach } from "vitest";
import { resolveOccurrence, type ResolvableItem, type ResolveDiagnostic } from "./resolve";

afterEach(() => {
  document.body.innerHTML = "";
});

function item(overrides: Partial<ResolvableItem> = {}): ResolvableItem {
  return {
    id: "item-1",
    text: "Add to Cart",
    tag: "button",
    selector: "#missing",
    ...overrides,
  };
}

function collectDiagnostics(): { diagnostics: ResolveDiagnostic[]; onDiagnostic: (d: ResolveDiagnostic) => void } {
  const diagnostics: ResolveDiagnostic[] = [];
  return { diagnostics, onDiagnostic: (d) => diagnostics.push(d) };
}

describe("resolveOccurrence", () => {
  it("1. resolves via the registry when the original element remains attached", () => {
    document.body.innerHTML = `<button id="btn">Add to Cart</button>`;
    const btn = document.getElementById("btn")!;
    const registry = new Map<string, Element>([["item-1", btn]]);
    const { diagnostics, onDiagnostic } = collectDiagnostics();

    const resolved = resolveOccurrence(item({ selector: "#btn" }), registry, { onDiagnostic });

    expect(resolved).toBe(btn);
    expect(diagnostics.map((d) => d.outcome)).toEqual(["registry"]);
  });

  it("1b. keeps resolving via the registry even after the text changes (ticking counter)", () => {
    // Regression guard: a countdown timer's text changes every second, but
    // it's still connected and still the same node -- tier 1 must not evict
    // it just because item.text (captured at extraction time) no longer
    // matches the live textContent.
    document.body.innerHTML = `<span id="timer">00:02</span>`;
    const span = document.getElementById("timer")!;
    const registry = new Map<string, Element>([["item-1", span]]);

    const resolved = resolveOccurrence(
      item({ tag: "span", text: "00:05", selector: "#timer" }),
      registry,
    );

    expect(resolved).toBe(span);
  });

  it("2. re-resolves an equivalent replacement node via the selector when the original is gone", () => {
    document.body.innerHTML = `<div id="slot"><button id="new-btn">Add to Cart</button></div>`;
    const registry = new Map<string, Element>(); // no stale entry -- simulates a fresh resolve
    const { diagnostics, onDiagnostic } = collectDiagnostics();

    const resolved = resolveOccurrence(item({ selector: "#slot > button" }), registry, {
      onDiagnostic,
    });

    expect(resolved).toBe(document.getElementById("new-btn"));
    expect(diagnostics.map((d) => d.outcome)).toEqual(["selector"]);
  });

  it("3. returns null when the original element is removed and nothing else matches", () => {
    document.body.innerHTML = `<div id="empty"></div>`;
    const registry = new Map<string, Element>();
    const { diagnostics, onDiagnostic } = collectDiagnostics();

    const resolved = resolveOccurrence(item({ selector: "#gone" }), registry, { onDiagnostic });

    expect(resolved).toBeNull();
    expect(diagnostics.map((d) => d.outcome)).toEqual(["not-found"]);
  });

  it("4/6. refuses to guess when multiple identical-text elements exist and neither is claimed", () => {
    document.body.innerHTML = `
      <div id="a"><button>Add to Cart</button></div>
      <div id="b"><button>Add to Cart</button></div>
    `;
    const registry = new Map<string, Element>();
    const { diagnostics, onDiagnostic } = collectDiagnostics();

    // Selector points nowhere (simulating a re-render that invalidated the
    // positional path), forcing tier 3's structural scan, which finds two
    // equally-valid "Add to Cart" buttons.
    const resolved = resolveOccurrence(item({ selector: "#gone" }), registry, { onDiagnostic });

    expect(resolved).toBeNull();
    expect(diagnostics).toEqual([
      expect.objectContaining({ outcome: "ambiguous", matchCount: 2 }),
    ]);
  });

  it("5. distinguishes two occurrences when one is replaced and the other slides into its selector slot", () => {
    // The doc's canonical failure case: Product A's div is removed, Product B
    // (same text) slides up and now occupies the exact positional selector
    // Product A's candidate remembers (e.g. both were "div:nth-of-type(1) >
    // button" relative to their own removed/remaining container -- collapsed
    // here to the same literal selector string for the test). Product A's
    // item must NOT resolve onto Product B's element merely because the
    // selector now resolves there and the text matches.
    document.body.innerHTML = `<div id="product-b"><button id="b-btn">Add to Cart</button></div>`;

    // Product B's own occurrence is already correctly registered...
    const registry = new Map<string, Element>([["item-b", document.getElementById("b-btn")!]]);

    // ...and Product A's item (a different occurrence id) re-queries a
    // selector that, after the DOM change, now resolves to Product B's node.
    const { diagnostics, onDiagnostic } = collectDiagnostics();
    const resolvedA = resolveOccurrence(
      item({ id: "item-a", selector: "#product-b > button" }),
      registry,
      { onDiagnostic },
    );

    // Product A must not be handed Product B's element.
    expect(resolvedA).toBeNull();
    expect(diagnostics.map((d) => d.outcome)).toEqual(["claimed"]);
    // Product B's own entry is undisturbed.
    expect(registry.get("item-b")).toBe(document.getElementById("b-btn"));
  });

  it("5b. the claim check also applies when both occurrences race through the structural scan", () => {
    // Same scenario, but via tier 3 (structural re-scan) instead of tier 2:
    // two equally-matching buttons exist, one already claimed by a different
    // occurrence id. The unclaimed one should NOT be silently handed out
    // either, because at that point there's no way to tell it apart from a
    // genuine ambiguous case -- filtering the claimed one first still leaves
    // exactly one candidate here, which is the one legitimate case tier 3
    // should accept.
    document.body.innerHTML = `
      <div id="a"><button id="a-btn">Add to Cart</button></div>
      <div id="b"><button id="b-btn">Add to Cart</button></div>
    `;
    const registry = new Map<string, Element>([["item-b", document.getElementById("b-btn")!]]);
    const { diagnostics, onDiagnostic } = collectDiagnostics();

    const resolvedA = resolveOccurrence(item({ id: "item-a", selector: "#gone" }), registry, {
      onDiagnostic,
    });

    expect(resolvedA).toBe(document.getElementById("a-btn"));
    expect(diagnostics.map((d) => d.outcome)).toEqual(["reresolved"]);
  });

  it("7. returns null with no candidates at all (no match)", () => {
    document.body.innerHTML = `<p>Nothing relevant here</p>`;
    const registry = new Map<string, Element>();

    const resolved = resolveOccurrence(item({ selector: "#gone", text: "Add to Cart" }), registry);

    expect(resolved).toBeNull();
  });

  it("8. SPA-style rerender: registry entry goes stale, resolver falls through to selector tier", () => {
    document.body.innerHTML = `<div id="slot"><button id="old">Add to Cart</button></div>`;
    const oldBtn = document.getElementById("old")!;
    const registry = new Map<string, Element>([["item-1", oldBtn]]);

    // Simulate a framework re-render: the old node is detached, a new one
    // takes its place at the same structural position.
    document.getElementById("slot")!.innerHTML = `<button id="new">Add to Cart</button>`;
    expect(oldBtn.isConnected).toBe(false);

    const resolved = resolveOccurrence(item({ selector: "#slot > button" }), registry);

    expect(resolved).toBe(document.getElementById("new"));
    expect(registry.get("item-1")).toBe(document.getElementById("new"));
  });

  it("never resolves via text alone -- a tag mismatch at the selector position is rejected", () => {
    document.body.innerHTML = `<div id="slot"><span id="not-a-button">Add to Cart</span></div>`;
    const registry = new Map<string, Element>();

    const resolved = resolveOccurrence(
      item({ tag: "button", selector: "#slot > span" }),
      registry,
    );

    expect(resolved).toBeNull();
  });

  it("detects a recycled registry node (tag changed under an existing connected reference)", () => {
    document.body.innerHTML = `<div id="recycled"></div>`;
    const div = document.getElementById("recycled")!;
    // A virtualized list reusing the same DOM node for different row content
    // would change its tag/subtree, not just its text. Registered as if it
    // were still the button occurrence:
    const registry = new Map<string, Element>([["item-1", div]]);
    const { diagnostics, onDiagnostic } = collectDiagnostics();

    const resolved = resolveOccurrence(item({ tag: "button", selector: "#gone" }), registry, {
      onDiagnostic,
    });

    expect(resolved).toBeNull();
    expect(diagnostics.map((d) => d.outcome)).toEqual(["stale-recycled", "not-found"]);
  });

  it("treats a missing item.tag as a non-match instead of throwing", () => {
    // Regression test: a real "Extension context invalidated" + "Cannot
    // read properties of undefined (reading 'toLowerCase')" pair, seen on a
    // live page. ClassifyItemResult.tag is typed as always-present, but a
    // stale chrome.storage.session "findings:<tabId>" entry written before
    // this field existed can hand this function `undefined` at runtime --
    // the type system can't catch that, since it's a value crossing a
    // serialization boundary from a different build. This must not throw.
    document.body.innerHTML = `<button id="btn">Add to Cart</button>`;
    const btn = document.getElementById("btn")!;
    const registry = new Map<string, Element>([["item-1", btn]]);

    const brokenItem = {
      ...item({ selector: "#btn" }),
      tag: undefined as unknown as string,
    };

    expect(() => resolveOccurrence(brokenItem, registry)).not.toThrow();
    // Registry tier requires a tag match too -- undefined never matches, so
    // this correctly falls through rather than badging the wrong thing.
    expect(resolveOccurrence(brokenItem, registry)).toBeNull();
  });
});
