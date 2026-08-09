import { describe, expect, it } from "vitest";
import { viewerCounter } from "./viewer_counter";
import { makeCandidate } from "./test-helpers";

describe("viewerCounter rule", () => {
  it("fires on 'N people viewing' in English", () => {
    const hits = viewerCounter(
      makeCandidate({ text: "128 people are viewing this right now" }),
      document.body,
    );
    expect(hits).toEqual([{ rule: "viewer_counter", label: "social_proof" }]);
  });

  it("fires on 'N watching'", () => {
    const hits = viewerCounter(makeCandidate({ text: "42 watching" }), document.body);
    expect(hits).toEqual([{ rule: "viewer_counter", label: "social_proof" }]);
  });

  it("does not fire on unrelated copy", () => {
    const hits = viewerCounter(
      makeCandidate({ text: "Free shipping over $50" }),
      document.body,
    );
    expect(hits).toEqual([]);
  });

  it("does not fire on a plain view count with no social framing", () => {
    // "1,204 views" alone isn't the live-social-proof phrasing this rule
    // targets -- a static view counter on a video is a different (benign)
    // pattern than "N people viewing this right now".
    const hits = viewerCounter(makeCandidate({ text: "1,204 views" }), document.body);
    expect(hits).toEqual([]);
  });
});
