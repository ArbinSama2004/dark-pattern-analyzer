import { describe, expect, it } from "vitest";
import { adoptCache, cacheVersionOf, reconcileCacheVersion } from "./classify-cache";
import type { SnippetResult } from "./api/classify";

function result(label: string): SnippetResult {
  return {
    snippet_id: "s",
    ref: "r",
    benign: false,
    benign_score: 0.1,
    scores: null,
    cached: false,
    findings: [
      {
        label,
        score: 0.7,
        threshold: 0.5,
        confidence: "possible",
        source: ["model"],
        description: "",
      },
    ],
  };
}

describe("cacheVersionOf", () => {
  it("treats a threshold-profile change as a different model", () => {
    // The profile changes which classes clear their thresholds, so the same
    // model at a different profile gives different answers to the same
    // question. The backend already folds it into its own cache key.
    expect(cacheVersionOf({ model_version: "1.0.0", threshold_profile: "precision" })).not.toBe(
      cacheVersionOf({ model_version: "1.0.0", threshold_profile: "recall" }),
    );
  });

  it("treats a retrain as a different model", () => {
    expect(cacheVersionOf({ model_version: "1.0.0", threshold_profile: "precision" })).not.toBe(
      cacheVersionOf({ model_version: "1.1.0", threshold_profile: "precision" }),
    );
  });
});

describe("adoptCache", () => {
  it("discards a cache written before the envelope existed", () => {
    // The old shape was a bare Record<modelCacheKey, SnippetResult>. Those
    // entries came from an unknown model; relabelling them with the current
    // version would be exactly the confusion this exists to prevent.
    expect(adoptCache({ "sha1-of-something": result("scarcity") })).toEqual({
      version: "",
      entries: {},
    });
  });

  it("discards anything that is not an envelope", () => {
    // Storage is untrusted input, the same reasoning as normalizeSettings.
    for (const raw of [undefined, null, 42, "text", [], { entries: {} }]) {
      expect(adoptCache(raw)).toEqual({ version: "", entries: {} });
    }
  });

  it("keeps an envelope written by this build", () => {
    const envelope = { version: "1.0.0:precision", entries: { k: result("scarcity") } };

    expect(adoptCache(envelope)).toBe(envelope);
  });
});

describe("reconcileCacheVersion", () => {
  it("empties the cache when the serving model changes", () => {
    const cache = {
      version: "1.0.0:precision",
      entries: { a: result("scarcity"), b: result("sneaking") },
    };

    const discarded = reconcileCacheVersion(cache, "1.1.0:precision");

    expect(discarded).toBe(2);
    expect(cache.entries).toEqual({});
    expect(cache.version).toBe("1.1.0:precision");
  });

  it("keeps everything when the model is unchanged", () => {
    const cache = { version: "1.0.0:precision", entries: { a: result("scarcity") } };

    expect(reconcileCacheVersion(cache, "1.0.0:precision")).toBe(0);
    expect(Object.keys(cache.entries)).toEqual(["a"]);
  });

  it("reports nothing discarded on the first response of a session", () => {
    // An empty cache adopting its first version has not lost anything, and
    // should not log as though it had.
    const cache = { version: "", entries: {} };

    expect(reconcileCacheVersion(cache, "1.0.0:precision")).toBe(0);
    expect(cache.version).toBe("1.0.0:precision");
  });
});
