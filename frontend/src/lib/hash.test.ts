import { describe, expect, it } from "vitest";
import { modelCacheKey, occurrenceId } from "./hash";

describe("occurrenceId", () => {
  it("gives distinct ids to identical text at different DOM locations", async () => {
    // The exact scenario Fix 1 exists for: three "Add to Cart" buttons, one
    // per product card, must be independently addressable candidates.
    const a = await occurrenceId("en", "Add to Cart", "div:nth-of-type(1) > button");
    const b = await occurrenceId("en", "Add to Cart", "div:nth-of-type(2) > button");
    const c = await occurrenceId("en", "Add to Cart", "div:nth-of-type(3) > button");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("gives the same id for the same lang+selector+text", async () => {
    const first = await occurrenceId("en", "Add to Cart", "div > button");
    const second = await occurrenceId("en", "Add to Cart", "div > button");
    expect(first).toBe(second);
  });

  it("changes when the language changes, selector and text held constant", async () => {
    const en = await occurrenceId("en", "Add to Cart", "div > button");
    const hi = await occurrenceId("hi", "Add to Cart", "div > button");
    expect(en).not.toBe(hi);
  });

  it("is a 40-char lowercase hex sha1 digest", async () => {
    const id = await occurrenceId("en", "Add to Cart", "div > button");
    expect(id).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("modelCacheKey", () => {
  it("is the same for two different DOM occurrences with identical model input", async () => {
    // This is the other half of Fix 1: distinct occurrences of the same
    // text/tag/role/lang are still allowed to share one model/cache entry.
    const productA = await modelCacheKey("en", "Add to Cart", "button", "cta");
    const productB = await modelCacheKey("en", "Add to Cart", "button", "cta");
    expect(productA).toBe(productB);
  });

  it("differs when role differs, text/tag/lang held constant", async () => {
    // hashing.py's own example: the same words mean something different on a
    // cancel button than in a paragraph.
    const asCta = await modelCacheKey("en", "Continue", "button", "cta");
    const asDecline = await modelCacheKey("en", "Continue", "button", "decline");
    expect(asCta).not.toBe(asDecline);
  });

  it("differs when tag differs, text/role/lang held constant", async () => {
    const asButton = await modelCacheKey("en", "Continue", "button", "cta");
    const asAnchor = await modelCacheKey("en", "Continue", "a", "cta");
    expect(asButton).not.toBe(asAnchor);
  });

  it("differs when text differs", async () => {
    const a = await modelCacheKey("en", "Only 2 left in stock!", "span", "stock");
    const b = await modelCacheKey("en", "Only 3 left in stock!", "span", "stock");
    expect(a).not.toBe(b);
  });
});

describe("occurrenceId vs modelCacheKey", () => {
  it("produce different values for the same inputs -- the two identities must not collide", async () => {
    const occ = await occurrenceId("en", "Add to Cart", "button");
    const model = await modelCacheKey("en", "Add to Cart", "button", "cta");
    expect(occ).not.toBe(model);
  });
});
