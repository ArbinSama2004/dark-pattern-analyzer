/**
 * Semantic grouping — **shadow mode**. Proposes units; changes nothing.
 *
 * The extractor emits one candidate per element, which means a UI statement
 * split across elements reaches the model in halves. Measured across six real
 * traces: 52% of all 1,960 extracted rows are two words or fewer, and the
 * consequences are visible in the labels —
 *
 *   - Daraz: `"Ends in"` and `"09:52:11"` are separate candidates, separately
 *     flagged. In Nepali the same pair came back as **two different labels**
 *     (`scarcity` and `false_urgency`) for one countdown.
 *   - Jeevee: `"रु."` and `"3190.01"` are separate candidates. Neither is a
 *     price on its own.
 *
 * Both are the same structural shape, and it is not the sibling adjacency one
 * might assume from looking at the rendered page:
 *
 *     <time>Ends in<span>09:52:11</span></time>
 *     <div>3190.01<span>रु.</span></div>
 *
 * A parent element with text of its own, plus inline children that carry the
 * rest. So this module implements exactly one relation — **containment through
 * inline elements** — rather than a catalogue of typed cases. That single rule
 * covers the timer label/value pair, the currency/amount pair and the
 * strike/current price comparison.
 *
 * ## Nothing here acts
 *
 * `proposeGroups` returns proposals. No candidate is suppressed, no model
 * request changes, no finding is merged. The proposals ride in the debug trace
 * so they can be reviewed against real pages *before* they are allowed to
 * affect anything. This project's costliest defects — `stock_counter` matching
 * `"N sold"`, `role=decline` matching "Cancelling" — were all confident,
 * plausible, and wrong for weeks, so a change that can silently discard model
 * inputs does not get to run until its proposals have been read.
 */

import type { CandidateWithElement } from "./extract";
import { isVideoPlayerContext } from "./role";
import { MAX_TEXT_LENGTH, MIN_TEXT_LENGTH } from "./types";

export type GroupType =
  | "timer_label_value"
  | "currency_amount"
  | "price_comparison"
  | "other";

export interface ProposedGroup {
  /** Candidate id of the outermost member -- the element that contains the
   * rest, and the natural badge anchor if grouping is ever activated. */
  id: string;
  type: GroupType;
  /** The unit as it would be sent to the model, fragments joined in DOM
   * order. Deliberately not reordered: the DOM order is what was actually
   * written, and a reconstruction that silently rearranges text is harder to
   * audit than one that reads slightly oddly. */
  text: string;
  /** Candidate ids of every member, outermost first. */
  memberIds: string[];
  /** The members' own texts, for reading a proposal back without cross-
   * referencing row ids. */
  fragments: string[];
  /** Why these were joined, in words, for the review sheet. */
  reason: string;
  /** True if any member's text has been observed changing on a regular
   * cadence. A countdown ticks and a clip length does not, which is the
   * signal that will decide whether a timer group may ever be activated --
   * recorded now, acted on never (shadow mode). */
  animated: boolean;
  /** True when the reconstruction says something no single fragment did
   * ("Ends in 09:52:11"). False when the outermost member already carried the
   * whole string and the group's only value is knowing which fragments it
   * represents -- the was/now price block is the common case. Both are worth
   * proposing; they would be acted on differently. */
  reconstructed: boolean;
}

/** Elements whose text may be folded into a parent's statement. Same list as
 * extract.ts's leaf-block heuristic: a block-level child means a new logical
 * unit, not a continuation of this one. */
const INLINE_TAGS = new Set([
  "a", "abbr", "b", "bdo", "big", "br", "button", "cite", "code", "dfn", "em",
  "i", "img", "input", "kbd", "label", "mark", "output", "q", "s", "samp",
  "select", "small", "span", "strong", "sub", "sup", "textarea", "time", "tt",
  "u", "var", "wbr",
]);

/** Controls whose label is its own statement. `<a>` and `<button>` are inline,
 * so without this a paragraph containing a link would swallow the link's text
 * into the surrounding prose. */
const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, [role="button"], [role="link"]';

const MMSS_RE = /\b\d{1,2}:\d{2}(:\d{2})?\b/;
const TIMER_LABEL_RE =
  /\b(ends?|starts?|closes?|expires?|left)\b|मा सकिदै|सकिन|समाप्त|बाँकी|खत्म|शेष/i;

/**
 * Video-player readouts, which have the identical `MM:SS` shape as a deadline.
 *
 * Shadow mode caught this on a real Amazon page before it could do anything:
 * `"Remaining Time - 0:00"` and `"Remaining Time - 0:36"` were typed
 * `timer_label_value`. That is the same family that produced 10 false
 * positives when role inference trusted the `MM:SS` shape -- and the
 * class-name check below it did not recognise Amazon's player then either,
 * which is why the wording is matched directly rather than relying on it.
 *
 * "remaining" was in the label list and is removed: a *duration* remaining is
 * a clip, and a deadline says what ends.
 */
const VIDEO_READOUT_RE =
  /\bremaining time\b|\belapsed\b|\bduration\b|\bcurrent time\b|\bplayback\b/i;
const CURRENCY_RE = /(?:rs\.?|npr|inr|₹|\$|€|£|रु\.?)/i;
const AMOUNT_RE = /\d[\d,]*(?:\.\d+)?/;

/**
 * Text of `el` with each descendant text node trimmed and joined by a single
 * space.
 *
 * Not `textContent`: `<time>Ends in<span>09:52:11</span></time>` has
 * `textContent === "Ends in09:52:11"`, because the separation between the two
 * is CSS, not whitespace. Joining the pieces is what the leaf-block path in
 * extract.ts already does, and for the same reason.
 */
export function reconstructText(el: Element): string {
  const pieces: string[] = [];
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? "").trim();
        if (text) pieces.push(text);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
      }
    }
  };
  walk(el);
  return pieces.join(" ").replace(/\s+/g, " ").trim();
}

/** True if every element between `el` and `ancestor` (inclusive of `el`) is
 * inline -- i.e. the text really is one visual run, not two blocks. */
function reachableThroughInlineOnly(el: Element, ancestor: Element): boolean {
  for (let node: Element | null = el; node && node !== ancestor; node = node.parentElement) {
    if (!INLINE_TAGS.has(node.tagName.toLowerCase())) return false;
  }
  return true;
}

/** The interactive control `el` sits in, if any. Two members in *different*
 * controls are two statements however close they are on screen. */
function interactiveAncestor(el: Element): Element | null {
  return typeof el.closest === "function" ? el.closest(INTERACTIVE_SELECTOR) : null;
}

function classify(el: Element, text: string, fragments: string[]): GroupType {
  if (
    MMSS_RE.test(text) &&
    TIMER_LABEL_RE.test(text) &&
    !VIDEO_READOUT_RE.test(text) &&
    !isVideoPlayerContext(el)
  ) {
    return "timer_label_value";
  }

  const amounts = text.match(new RegExp(`${CURRENCY_RE.source}\\s*${AMOUNT_RE.source}`, "gi"));
  if (amounts && amounts.length >= 2) return "price_comparison";
  if (
    fragments.some((f) => CURRENCY_RE.test(f) && !AMOUNT_RE.test(f)) &&
    fragments.some((f) => AMOUNT_RE.test(f) && !CURRENCY_RE.test(f))
  ) {
    return "currency_amount";
  }
  return "other";
}

const REASONS: Record<GroupType, string> = {
  timer_label_value: "a countdown's label and its value, split across elements",
  currency_amount: "a currency symbol and its amount, split across elements",
  price_comparison: "two prices in one element -- the was/now comparison",
  other: "a parent's text continued by its inline children",
};

/**
 * Proposes one group per candidate element that contains other candidate
 * elements through inline markup only.
 *
 * Refusals, each one a boundary this must never cross:
 *
 * - a **block-level** element anywhere between the two: that is a new unit
 * - members in **different interactive controls**: two buttons are two
 *   statements, and `<a>`/`<button>` are inline tags
 * - a reconstruction outside the same 3-200 character bounds every candidate
 *   already obeys
 * - a group whose reconstruction duplicates a group nested inside it: the
 *   inner one has the tighter anchor, and anchoring to an outer container is
 *   what once outlined an entire product image
 */
export function proposeGroups(pairs: CandidateWithElement[]): ProposedGroup[] {
  const byElement = new Map<Element, CandidateWithElement>();
  for (const pair of pairs) byElement.set(pair.el, pair);

  const groups: Array<{ el: Element; group: ProposedGroup }> = [];

  for (const outer of pairs) {
    const members: CandidateWithElement[] = [];

    for (const inner of pairs) {
      if (inner === outer) continue;
      if (!outer.el.contains(inner.el)) continue;
      if (!reachableThroughInlineOnly(inner.el, outer.el)) continue;

      const outerControl = interactiveAncestor(outer.el);
      const innerControl = interactiveAncestor(inner.el);
      if (innerControl !== outerControl && innerControl !== null && !outer.el.contains(innerControl)) {
        continue;
      }
      // The member is its own control, nested inside a non-control parent:
      // a link inside a paragraph. Its label is its own statement.
      if (innerControl !== null && innerControl !== outerControl && outer.el.contains(innerControl)) {
        continue;
      }
      members.push(inner);
    }

    if (members.length === 0) continue;

    const text = reconstructText(outer.el);
    if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) continue;

    // Outermost first, then the members in document order, so a reviewer reads
    // the proposal the way the page is written.
    const ordered = members.slice().sort((a, b) => {
      const position = a.el.compareDocumentPosition(b.el);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    const fragments = [outer.candidate.text, ...ordered.map((m) => m.candidate.text)];
    const type = classify(outer.el, text, fragments);

    groups.push({
      el: outer.el,
      group: {
        id: outer.candidate.id,
        type,
        text,
        memberIds: [outer.candidate.id, ...ordered.map((m) => m.candidate.id)],
        fragments,
        reason: REASONS[type],
        animated: [outer, ...ordered].some((m) => m.candidate.is_animated),
        reconstructed: text !== outer.candidate.text,
      },
    });
  }

  // A container and the element inside it can both reconstruct the same
  // string -- <div><time>Ends in<span>09:52:11</span></time></div> proposes
  // the identical unit twice. Keep the inner one: it is the tightest box
  // around the words, which is the same reason collapseNestedDuplicates keeps
  // the innermost element.
  return groups
    .filter(
      ({ el, group }) =>
        !groups.some(
          (other) => other.el !== el && el.contains(other.el) && other.group.text === group.text,
        ),
    )
    .map(({ group }) => group);
}
