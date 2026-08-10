import type { Lang } from "../taxonomy";
import { occurrenceId } from "../hash";
import { inferRole } from "./role";
import { stableSelector } from "./selector";
import { stickyChromeAncestor } from "./sticky";
import {
  MAX_TEXT_LENGTH,
  MIN_TEXT_LENGTH,
  SKIP_TAGS,
  type Candidate,
} from "./types";

/** Inline HTML elements whose text can be merged with siblings into one
 * logical unit. Kept here rather than imported from a constant file so
 * the leaf-block heuristic is self-contained. */
const INLINE_TAGS = new Set([
  "a", "abbr", "acronym", "b", "bdo", "big", "br", "button",
  "cite", "code", "dfn", "em", "i", "img", "input", "kbd",
  "label", "map", "object", "output", "q", "s", "samp", "select",
  "small", "span", "strong", "sub", "sup", "textarea", "time",
  "tt", "u", "var",
]);

/**
 * When a block element has no direct text but all its children are inline
 * elements (span, strong, s, del, etc.), e-commerce pages often compose a
 * single logical string split across those inlines -- e.g.:
 *
 *   <div class="pdp-discount"><span>-8%</span></div>
 *   <div class="price"><s>NPR 1,299</s><span>NPR 1,199</span></div>
 *
 * In those cases, join the children's text into one string and use that
 * as the candidate text instead of skipping the parent (which previously
 * happened because directText was empty).
 *
 * Returns null if the element has non-inline child elements or if the
 * joined text is outside [MIN_TEXT_LENGTH, MAX_TEXT_LENGTH].
 */
function leafBlockText(el: Element): string | null {
  const children = Array.from(el.childNodes);
  // Must have at least one child to be worth coalescing.
  if (children.length === 0) return null;

  // All children must be text nodes or inline elements. A block-level
  // child (div, p, section…) means this is a structural container, not a
  // leaf -- let the walker descend into it naturally instead.
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as Element).tagName.toLowerCase();
      if (INLINE_TAGS.has(tag)) continue;
    }
    return null; // non-inline child element → not a leaf block
  }

  const joined = children
    .map((n) => (n.textContent ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (joined.length < MIN_TEXT_LENGTH || joined.length > MAX_TEXT_LENGTH) {
    return null;
  }
  return joined;
}

/**
 * Minimum length of the repeated half before collapseSelfDuplicate() acts.
 * Guards against coincidental short repeats ("aa", "88", a two-char price
 * fragment) that are real content, not a duplication artifact -- every
 * observed real case ("Discover more", "Shop gaming") is well above this.
 */
const MIN_DUPLICATE_HALF_LENGTH = 4;

/**
 * Collapses "TT" (T immediately repeated, no separator) down to "T".
 *
 * Real trace data caught this: some sites (confirmed on Amazon's home page,
 * ~6% of candidates on one real trace) render a label's text twice in the
 * DOM back-to-back for a CSS hover/flip animation -- one copy visually
 * swapped in via `transform`/`overflow` clipping, not `display`/
 * `visibility`/`opacity`, so `isVisible()` has no way to tell the two apart
 * and both flow into the extracted text with no separating whitespace
 * ("Discover moreDiscover more", "Shop gamingShop gaming"). The underlying
 * content is real -- this isn't a candidate to drop -- but sending the
 * doubled string is wasted payload and an unnaturally-shaped input the
 * model never saw in training. Collapsing to one copy fixes both.
 */
function collapseSelfDuplicate(text: string): string {
  if (text.length % 2 !== 0) return text;
  const half = text.length / 2;
  if (half < MIN_DUPLICATE_HALF_LENGTH) return text;
  const first = text.slice(0, half);
  const second = text.slice(half);
  return first === second ? first : text;
}


function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;

  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  // offsetParent is null for display:none (already caught above) AND for
  // position:fixed/sticky, which are exactly the elements cookie banners
  // and modals use. Falling back to offsetParent === null here would
  // silently drop the highest-value candidates on the page while still
  // reporting a healthy extraction count -- no error, just quietly worse
  // coverage. Fixed/sticky elements are treated as visible directly instead
  // of running through offsetParent at all.
  if (style.position === "fixed" || style.position === "sticky") {
    return true;
  }

  if (el.offsetParent === null && el.tagName !== "BODY" && el.tagName !== "HTML") {
    return false;
  }

  return true;
}

function contrastRatio(el: HTMLElement): number | null {
  // WCAG relative-luminance contrast between computed color and background.
  // Walks up for the first non-transparent background if the element itself
  // is transparent (the common case for inline text nodes).
  const style = getComputedStyle(el);
  const fg = parseRgb(style.color);
  let node: HTMLElement | null = el;
  let bg: [number, number, number] | null = null;
  while (node) {
    const bgColor = getComputedStyle(node).backgroundColor;
    const parsed = parseRgb(bgColor);
    if (parsed && bgColor !== "rgba(0, 0, 0, 0)" && bgColor !== "transparent") {
      bg = parsed;
      break;
    }
    node = node.parentElement;
  }
  if (!fg || !bg) return null;
  return contrastBetween(fg, bg);
}

function parseRgb(value: string): [number, number, number] | null {
  const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLinear = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastBetween(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function inferStep(): Candidate["step"] {
  // Cheap heuristic on the current URL; refined once real fixture pages
  // (backend/tests/fixtures/pages/) are available to test against.
  const path = location.pathname.toLowerCase();
  if (/checkout|payment|pay\b/.test(path)) return "payment";
  if (/cart|bag/.test(path)) return "cart";
  return "product";
}

function collectRoots(root: ParentNode): ParentNode[] {
  const roots: ParentNode[] = [root];
  const walker = document.createTreeWalker(
    root as Node,
    NodeFilter.SHOW_ELEMENT,
  );
  let node = walker.nextNode() as Element | null;
  while (node) {
    if (node.shadowRoot) {
      roots.push(...collectRoots(node.shadowRoot));
    }
    if (
      node.tagName === "IFRAME" &&
      isSameOriginIframe(node as HTMLIFrameElement)
    ) {
      const doc = (node as HTMLIFrameElement).contentDocument;
      if (doc) roots.push(...collectRoots(doc));
    }
    node = walker.nextNode() as Element | null;
  }
  return roots;
}

function isSameOriginIframe(iframe: HTMLIFrameElement): boolean {
  try {
    // Accessing contentDocument throws (or returns null) cross-origin.
    return iframe.contentDocument !== null;
  } catch {
    return false;
  }
}

export interface CandidateWithElement {
  candidate: Candidate;
  el: Element;
}

/**
 * Walks the document (plus open shadow roots and same-origin iframes),
 * extracts candidate text nodes, and returns deduplicated
 * {candidate, el} pairs. Cross-origin iframes are unreachable by design --
 * see docs/ARCHITECTURE.md section 4.1 and the risk register in section 12.
 *
 * Returning the live element (not just the Candidate data) is what lets
 * content.ts run rules that need computed styles or live state
 * (hidden_optout, cta_asymmetry, prechecked_optin) without a second
 * document walk or a `querySelector(candidate.selector)` round-trip -- the
 * selector string is for later re-location (e.g. the side panel's
 * scroll-and-highlight), not for this.
 */
export async function extractCandidatesWithElements(
  lang: Lang,
  root: ParentNode = document,
): Promise<CandidateWithElement[]> {
  const seen = new Set<string>();
  const out: CandidateWithElement[] = [];
  const step = inferStep();

  for (const docRoot of collectRoots(root)) {
    const walker = document.createTreeWalker(
      docRoot as Node,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          const el = node as Element;
          const tag = el.tagName.toLowerCase();
          if (SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
          if (el.getAttribute("aria-hidden") === "true") {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    let node = walker.nextNode() as Element | null;
    while (node) {
      const el = node;
      node = walker.nextNode() as Element | null; // advance before any early continue

      // Only consider elements whose *direct* text (not descendants') is
      // substantive -- otherwise every ancestor duplicates its children's text.
      const directText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      // Leaf-block fallback: if the element has no direct text but all its
      // children are inline tags (span, strong, s, del, …), treat the joined
      // children as one logical string. This is how discount badges and
      // crossed-out price elements are typically written on e-commerce pages:
      //   <div class="pdp-discount"><span>-8%</span></div>
      //   <div class="price"><s>NPR 1,299</s> <span>NPR 1,199</span></div>
      // Without this they were silently skipped because directText === "".
      const candidateText = collapseSelfDuplicate(
        directText.length >= MIN_TEXT_LENGTH && directText.length <= MAX_TEXT_LENGTH
          ? directText
          : (leafBlockText(el) ?? ""),
      );

      if (
        candidateText.length < MIN_TEXT_LENGTH ||
        candidateText.length > MAX_TEXT_LENGTH ||
        /^\d+$/.test(candidateText)
      ) {
        continue;
      }
      if (!isVisible(el)) continue;

      // Skip text living inside a pinned header/navbar. Its viewport rect
      // never changes while scrolling, so any badge anchored to it would sit
      // welded to the top-left corner of the screen for the whole session --
      // and the text itself ("Returns & Orders", "Help", "Cancel") is site
      // chrome, not a checkout-flow dark pattern. Non-nav fixed/sticky
      // elements (cookie banners, modals, bottom bars) are deliberately still
      // extracted -- see lib/extract/sticky.ts.
      if (stickyChromeAncestor(el)) continue;

      // Computed before the id so the id can fold in position, not just
      // text -- see hash.ts's occurrenceId doc comment. This is what keeps
      // "Add to Cart" on product A distinct from "Add to Cart" on product B:
      // previously the id was sha1(lang+text) alone, so every DOM occurrence
      // of the same string collapsed onto one candidate, one elementRegistry
      // entry, and one badge -- silently discarding the rest with no record,
      // and role inference below only ever ran on whichever occurrence the
      // walker reached first.
      const selector = stableSelector(el);
      const id = await occurrenceId(lang, candidateText, selector);
      // Still guards against a genuine collision (two distinct elements
      // landing on the same selector, which selector.ts's own doc comment
      // says is possible on a pathological page) -- not, as before, the
      // primary mechanism for suppressing same-text duplicates.
      if (seen.has(id)) continue;
      seen.add(id);

      // Pass candidateText explicitly -- see role.ts's doc comment on the
      // `candidateText` param. Without this, inferRole() re-derives text
      // from el.textContent directly, which can disagree with the joined
      // text actually sent to the model whenever leafBlockText() had to
      // insert a separating space that the raw DOM didn't have.
      const role = inferRole(el, lang, candidateText);
      const htmlEl = el instanceof HTMLElement ? el : null;
      const style = htmlEl ? getComputedStyle(htmlEl) : null;

      out.push({
        candidate: {
          id,
          text: candidateText,
          tag: el.tagName.toLowerCase(),
          role,
          lang,
          visible: true,
          font_px: style ? parseFloat(style.fontSize) : null,
          contrast: htmlEl ? contrastRatio(htmlEl) : null,
          checked:
            el instanceof HTMLInputElement &&
            (el.type === "checkbox" || el.type === "radio")
              ? el.checked
              : null,
          is_animated: false, // set by the timer-cadence tracker, see entrypoints/content.ts
          step,
          selector,
        },
        el,
      });
    }
  }

  return out;
}

/** Candidate-data-only convenience wrapper for callers (and tests) that
 * don't need the live element -- extractCandidatesWithElements is the
 * primary implementation. */
export async function extractCandidates(
  lang: Lang,
  root: ParentNode = document,
): Promise<Candidate[]> {
  const pairs = await extractCandidatesWithElements(lang, root);
  return pairs.map((p) => p.candidate);
}
