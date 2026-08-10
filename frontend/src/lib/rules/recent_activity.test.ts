import { describe, expect, it } from "vitest";
import { recentActivity } from "./recent_activity";
import { makeCandidate } from "./test-helpers";

const HIT = [{ rule: "recent_activity", label: "social_proof" }];

describe("recentActivity rule", () => {
  it("fires on the exact phrasing docs/ANNOTATION.md lists as dark", () => {
    // "{N} bought in the last {H} hours" -- and a real miss: the model failed to
    // flag this on a live page (docs/RESULTS.md section 7, false negatives).
    const hits = recentActivity(
      makeCandidate({ text: "61 people bought this in the last 24 hours" }),
      document.body,
    );
    expect(hits).toEqual(HIT);
  });

  it("fires with the count trailing the window", () => {
    const hits = recentActivity(
      makeCandidate({ text: "In the past hour, 12 shoppers ordered this item" }),
      document.body,
    );
    expect(hits).toEqual(HIT);
  });

  it("fires on 'selling fast'", () => {
    expect(
      recentActivity(makeCandidate({ text: "Selling fast!" }), document.body),
    ).toEqual(HIT);
  });

  it("does NOT fire on a bare cumulative sale count", () => {
    // The whole point of splitting this out of stock_counter. A settled total is
    // benign per docs/ANNOTATION.md; only a recency-bounded claim is dark.
    for (const text of ["330 sold", "958 sold", "7 sold Overseas", "100+ sold"]) {
      expect(recentActivity(makeCandidate({ text }), document.body)).toEqual([]);
    }
  });

  it("does NOT fire on an explicitly settled, auditable aggregate", () => {
    // docs/ANNOTATION.md's benign column, verbatim.
    for (const text of [
      "Bestseller - 400 sold this week",
      "Based on 1,832 verified purchases",
      "Rated by 240 verified buyers",
    ]) {
      expect(recentActivity(makeCandidate({ text }), document.body)).toEqual([]);
    }
  });

  it("does not fire on ordinary delivery or logistics copy", () => {
    for (const text of [
      "Delivered in the last 3 days",
      "Order in the next 2 hours for delivery tomorrow",
      "Guaranteed by 13-14 Aug",
    ]) {
      expect(recentActivity(makeCandidate({ text }), document.body)).toEqual([]);
    }
  });

  it("fires on Hindi and Nepali recency phrasing", () => {
    expect(
      recentActivity(
        makeCandidate({ text: "पिछले 24 घंटों में 61 लोगों ने खरीदा" }),
        document.body,
      ),
    ).toEqual(HIT);
    expect(
      recentActivity(
        makeCandidate({ text: "गत 24 घण्टामा 61 जनाले किने" }),
        document.body,
      ),
    ).toEqual(HIT);
  });
});
