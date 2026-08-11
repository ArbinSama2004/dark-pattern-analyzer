import type { SnippetResult } from "./api/classify";

/**
 * The extension's prediction cache, and the model identity it was built
 * against.
 *
 * The backend puts `model_version` and the threshold profile into every one of
 * its own cache keys -- invariant #4 -- so that a retrain or a profile change
 * invalidates its cache with no flush. This cache did not. It was a bare
 * `Record<modelCacheKey, SnippetResult>`, and `modelCacheKey` covers
 * lang+tag+role+text only. Restart the backend on a different profile, or drop
 * in a retrained bundle, and every open tab kept serving the previous model's
 * answers for the rest of the browser session, with nothing to indicate that
 * two models' verdicts were now mixed together on one page.
 *
 * The extension cannot know the model version up front, but every classify
 * response carries it in `meta`. Recording it and discarding the cache when it
 * changes extends the same invariant across the wire.
 *
 * Kept in `lib/` rather than inside the service worker so it can be tested
 * without a chrome API double -- and so the test exercises the real function
 * rather than a copy of it that can drift.
 */
export interface CacheEnvelope {
  /** `${model_version}:${threshold_profile}` from the last response observed,
   * or `""` before the first one. */
  version: string;
  entries: Record<string, SnippetResult>;
}

/** Identity of whatever produced a result. Any change here must invalidate
 * every entry, because the entries are answers from a different system. */
export function cacheVersionOf(meta: {
  model_version: string;
  threshold_profile: string;
}): string {
  return `${meta.model_version}:${meta.threshold_profile}`;
}

/**
 * Normalises whatever is in storage into an envelope.
 *
 * A cache written by a build before the envelope existed is **discarded**, not
 * adopted: its entries came from an unknown model, and silently relabelling
 * them with the current version would be the exact confusion this exists to
 * prevent. Same reasoning as `normalizeSettings` -- storage is untrusted input.
 */
export function adoptCache(raw: unknown): CacheEnvelope {
  if (
    raw !== null &&
    typeof raw === "object" &&
    "entries" in raw &&
    typeof (raw as CacheEnvelope).version === "string"
  ) {
    return raw as CacheEnvelope;
  }
  return { version: "", entries: {} };
}

/** Empties the cache when the serving model's identity has changed. Returns
 * whether anything was discarded, so the caller can say so. */
export function reconcileCacheVersion(cache: CacheEnvelope, version: string): number {
  if (cache.version === version) return 0;
  const discarded = cache.version === "" ? 0 : Object.keys(cache.entries).length;
  cache.entries = {};
  cache.version = version;
  return discarded;
}
