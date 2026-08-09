import type { Lang } from "../taxonomy";
import { snippetId } from "../hash";
import { inferRole } from "./role";
import { stableSelector } from "./selector";
import {
  MAX_TEXT_LENGTH,
  MIN_TEXT_LENGTH,
  SKIP_TAGS,
  type Candidate,
} from "./types";

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

      if (
        directText.length < MIN_TEXT_LENGTH ||
        directText.length > MAX_TEXT_LENGTH ||
        /^\d+$/.test(directText)
      ) {
        continue;
      }
      if (!isVisible(el)) continue;

      const id = await snippetId(lang, directText);
      if (seen.has(id)) continue;
      seen.add(id);

      const role = inferRole(el, lang);
      const htmlEl = el instanceof HTMLElement ? el : null;
      const style = htmlEl ? getComputedStyle(htmlEl) : null;

      out.push({
        candidate: {
          id,
          text: directText,
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
          selector: stableSelector(el),
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
