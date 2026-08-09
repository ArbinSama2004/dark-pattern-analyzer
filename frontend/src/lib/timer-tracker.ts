/**
 * Tracks whether an element's text has been changing on a roughly-1-second
 * cadence -- the `is_animated` signal countdown_timer's rule reads. See
 * docs/ARCHITECTURE.md 4.1, "Change detection": this is the deliberate
 * exception to the 300ms-debounced main observer, and it counts locally,
 * never sending per tick.
 *
 * Keyed by stableSelector rather than the element reference or the
 * candidate id, because a ticking timer's candidate id changes every
 * second (id = sha1(lang + text), and the text is the thing changing) --
 * indexing by id would never accumulate a cadence history at all, which is
 * the exact bug this file exists to avoid repeating.
 */
const MIN_CADENCE_MS = 700;
const MAX_CADENCE_MS = 1500;
const HISTORY_WINDOW = 4; // consecutive matching-cadence ticks required
const HAS_DIGITS_RE = /\d/;

interface TrackedEntry {
  lastText: string;
  lastChangeAt: number;
  consecutiveTickMatches: number;
}

const tracked = new Map<string, TrackedEntry>();

/** Call on every DOM mutation (undebounced) for each element in play, not
 * just once per extraction pass -- the cadence can only be measured by
 * observing more often than the 300ms-debounced extraction runs. */
export function recordObservation(selector: string, text: string): void {
  if (!HAS_DIGITS_RE.test(text)) {
    tracked.delete(selector);
    return;
  }

  const now = Date.now();
  const entry = tracked.get(selector);

  if (!entry) {
    tracked.set(selector, { lastText: text, lastChangeAt: now, consecutiveTickMatches: 0 });
    return;
  }

  if (entry.lastText === text) return; // no change yet, nothing to score

  const delta = now - entry.lastChangeAt;
  const withinCadence = delta >= MIN_CADENCE_MS && delta <= MAX_CADENCE_MS;

  tracked.set(selector, {
    lastText: text,
    lastChangeAt: now,
    consecutiveTickMatches: withinCadence ? entry.consecutiveTickMatches + 1 : 0,
  });
}

/** True once an element has changed on a ~1s cadence for several
 * consecutive ticks -- a couple of coincidental matches shouldn't be enough
 * to call something a timer. */
export function isAnimated(selector: string): boolean {
  const entry = tracked.get(selector);
  return (entry?.consecutiveTickMatches ?? 0) >= HISTORY_WINDOW;
}

/** Exposed for tests and for content.ts to clear state on navigation. */
export function resetTimerTracking(): void {
  tracked.clear();
}
