import { describe, expect, it } from "vitest";
import { findingsStorageKey, lastDocumentUrlKey, stripFragment } from "./messaging";

describe("stripFragment", () => {
  it("removes a fragment", () => {
    expect(stripFragment("https://daraz.com.np/#hp-flash-sale")).toBe(
      "https://daraz.com.np/",
    );
  });

  it("leaves a fragmentless URL alone", () => {
    expect(stripFragment("https://daraz.com.np/products/x")).toBe(
      "https://daraz.com.np/products/x",
    );
  });

  it("collapses two section anchors on the same page to one document", () => {
    // The actual reported bug: Daraz rewrites the hash as you scroll its home
    // page, and the findings were being cleared on every one of those. These
    // two must compare equal or scrolling wipes the side panel.
    expect(stripFragment("https://daraz.com.np/#hp-flash-sale")).toBe(
      stripFragment("https://daraz.com.np/#hp-just-for-you"),
    );
  });

  it("keeps genuinely different documents distinct", () => {
    expect(stripFragment("https://daraz.com.np/#a")).not.toBe(
      stripFragment("https://daraz.com.np/catalog/#a"),
    );
  });

  it("treats a query-string change as a different document", () => {
    // A search results page differs from another search's results, even though
    // the path matches -- the DOM is entirely replaced, so findings must not
    // carry over.
    expect(stripFragment("https://daraz.com.np/catalog/?q=shoes")).not.toBe(
      stripFragment("https://daraz.com.np/catalog/?q=laptops"),
    );
  });

  it("handles an empty fragment", () => {
    expect(stripFragment("https://daraz.com.np/#")).toBe("https://daraz.com.np/");
  });

  it("returns unparseable input unchanged so it compares equal to itself", () => {
    expect(stripFragment("not a url")).toBe("not a url");
  });
});

describe("per-tab storage keys", () => {
  it("are distinct per tab", () => {
    expect(findingsStorageKey(1)).not.toBe(findingsStorageKey(2));
    expect(lastDocumentUrlKey(1)).not.toBe(lastDocumentUrlKey(2));
  });

  it("do not collide with each other for the same tab", () => {
    expect(findingsStorageKey(1)).not.toBe(lastDocumentUrlKey(1));
  });
});
