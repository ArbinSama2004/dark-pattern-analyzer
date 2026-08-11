import { describe, expect, it } from "vitest";
import { runRules, ruleAllowedOnField } from "./index";
import { makeCandidate } from "./test-helpers";

/**
 * The field gate, tested at the level that matters: the same words are a
 * finding in one place on a product card and seller copy in another, and
 * nothing in the text itself can tell them apart.
 */
describe("field gating", () => {
  function element(html = "<span></span>"): Element {
    document.body.innerHTML = html;
    return document.body.firstElementChild!;
  }

  it("does not report scarcity for wording inside a product title", () => {
    // The measured symptom: `stock_counter` matches /limited (time|offer|
    // stock)/ unanchored, so a 45-character title flagged as scarcity at the
    // UI's strongest confidence -- while the classifier called the same title
    // benign at 0.896.
    const candidate = makeCandidate({
      text: "Hot Sale Wireless Earbuds Limited Stock Offer",
      field: "title",
    });

    expect(runRules(candidate, element())).toEqual([]);
  });

  it("still reports the same wording on a badge", () => {
    // The rule is not wrong, it was only unplaced. On a stock badge the exact
    // same match is the finding it was written for.
    const candidate = makeCandidate({ text: "Limited Stock", field: "stock" });

    expect(runRules(candidate, element()).map((h) => h.rule)).toContain("stock_counter");
  });

  it("leaves rules unrestricted when the field could not be identified", () => {
    // `unknown` is an honest absence of evidence, not a reason to suppress.
    // Blocking on it would silently disable the rule layer on every page
    // whose markup fields.ts cannot read.
    const candidate = makeCandidate({ text: "Only 3 left", field: "unknown" });

    expect(runRules(candidate, element()).map((h) => h.rule)).toContain("stock_counter");
  });

  it("does not report a discount badge on a settled sale count", () => {
    expect(ruleAllowedOnField("discount_badge", "sold_count")).toBe(false);
    expect(ruleAllowedOnField("discount_badge", "discount")).toBe(true);
  });

  it("leaves the structural rules free everywhere except a product title", () => {
    // These judge structure -- a pre-checked box, a faded decline link, an
    // off-site cancel route -- and structure means the same thing wherever it
    // appears, so they are unrestricted by default.
    for (const rule of [
      "prechecked_optin",
      "hidden_optout",
      "forced_action_gate",
      "late_fee",
    ]) {
      for (const field of ["title", "price", "rating", "discount"] as const) {
        expect(ruleAllowedOnField(rule, field)).toBe(true);
      }
    }

    // Two exceptions, added after a real trace: `cancel_offsite` and
    // `cta_asymmetry` fired on four Amazon product titles, because
    // "Noise Cancelling" had been mistyped as role=decline. role.ts's
    // word-boundary fix removes the cause; this refuses the result as well,
    // since a product title is never an interactive control.
    expect(ruleAllowedOnField("cancel_offsite", "title")).toBe(false);
    expect(ruleAllowedOnField("cta_asymmetry", "title")).toBe(false);
    expect(ruleAllowedOnField("cancel_offsite", "unknown")).toBe(true);
  });

  it("does not call a ticking price or rating a countdown", () => {
    // `countdown_timer` tests `is_animated` and nothing else -- there is no
    // clock-shape check anywhere in it -- so a rotating price, a live rating
    // or an animated sale count would all have been reported as
    // `false_urgency`. Naming the fields where a changing number is not a
    // deadline is narrower than inventing a text-shape test, which a real
    // "2 days 04 hours" countdown would fail.
    for (const field of ["price", "strike_price", "rating", "sold_count", "title"] as const) {
      expect(ruleAllowedOnField("countdown_timer", field)).toBe(false);
    }
    // Still free where a ticking number really is a deadline, and on the
    // honest absence of evidence.
    expect(ruleAllowedOnField("countdown_timer", "stock")).toBe(true);
    expect(ruleAllowedOnField("countdown_timer", "unknown")).toBe(true);
  });

  it("never lets a rule report on a personal identifier", () => {
    // An email address or an order number is not a manipulative pattern in
    // any field, and it never reaches the model either (content.ts).
    for (const rule of ["stock_counter", "recent_activity", "viewer_counter", "discount_badge"]) {
      expect(ruleAllowedOnField(rule, "personal")).toBe(false);
    }
  });

  it("does not run text-matching rules over customer reviews", () => {
    // A review saying "there were only 3 left when I ordered" is a shopper
    // recounting their purchase, not a scarcity cue the site is deploying.
    expect(ruleAllowedOnField("stock_counter", "prose")).toBe(false);
    expect(ruleAllowedOnField("viewer_counter", "prose")).toBe(false);
    expect(ruleAllowedOnField("recent_activity", "prose")).toBe(false);
  });
});
