/**
 * Detection of "persistent page chrome" -- fixed/sticky headers, navbars and
 * toolbars that stay pinned to the top of the viewport while the user scrolls.
 *
 * Why this exists: `isVisible()` in extract.ts deliberately treats
 * `position: fixed|sticky` elements as visible, because that is exactly how
 * cookie banners and consent modals are built and those are high-value
 * candidates. The side effect is that a site's global header (Amazon's
 * `<header id="navbar">`, Daraz's sticky top bar) also survives extraction.
 * Its links -- "Returns & Orders", "Cancel", "Help" -- trip obstruction rules
 * like cancel_offsite / cta_asymmetry, and because the element's viewport rect
 * never moves, the resulting badge sits pinned at the top-left corner of the
 * screen for the entire scroll session.
 *
 * So we filter *nav-like* persistent chrome only, and leave every other
 * fixed/sticky element (banners, modals, drawers, bottom bars) alone.
 */

/** id/class tokens that mark a container as site navigation chrome. */
const CHROME_HINT =
  /(?:^|[-_\s])(?:nav|navbar|nav-bar|navigation|header|topbar|top-bar|masthead|toolbar|appbar|app-bar|site-header|global-header|gh|sticky-header|page-header)(?:[-_\s]|$)/i;

/** A persistent bar taller than this fraction of the viewport is probably a
 * full-screen overlay/modal, not a header -- don't filter those out. */
const MAX_CHROME_HEIGHT_RATIO = 0.4;

/** How far from the top of the viewport a bar can sit and still count as a
 * pinned header. Generous enough for sites that stack an announcement strip
 * above the real navbar. */
const MAX_CHROME_TOP_PX = 160;

function hasNavSemantics(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "header" || tag === "nav") return true;

  const role = el.getAttribute("role");
  if (role === "banner" || role === "navigation") return true;

  const id = el.id ?? "";
  if (id && CHROME_HINT.test(id)) return true;

  // className is a SVGAnimatedString on SVG elements -- guard the type.
  const cls = typeof el.className === "string" ? el.className : "";
  if (cls && CHROME_HINT.test(cls)) return true;

  return false;
}

function isPinnedToTop(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const viewportHeight = window.innerHeight || 0;
  if (viewportHeight === 0) return false;
  if (rect.height > viewportHeight * MAX_CHROME_HEIGHT_RATIO) return false;
  // A sticky header that hasn't stuck yet still reports its in-flow position,
  // which can be well below the fold on first paint. Allow anything whose top
  // edge is at or above the fold; the height cap above already excludes
  // full-page overlays.
  return rect.top <= MAX_CHROME_TOP_PX;
}

/**
 * Returns the nearest ancestor-or-self that is a fixed/sticky navigation bar
 * pinned near the top of the viewport, or null if there is none.
 *
 * Kept as a lookup returning the container (rather than a boolean) so callers
 * can log *what* was filtered when diagnosing a missing candidate.
 */
export function stickyChromeAncestor(el: Element): Element | null {
  if (typeof getComputedStyle !== "function") return null;

  let node: Element | null = el;
  let depth = 0;
  // 24 levels is deeper than any real header nesting; the bound keeps this
  // cheap enough to run per candidate during extraction.
  while (node && depth < 24) {
    if (node instanceof HTMLElement) {
      const position = getComputedStyle(node).position;
      if (
        (position === "fixed" || position === "sticky") &&
        hasNavSemantics(node) &&
        isPinnedToTop(node)
      ) {
        return node;
      }
    }
    node = node.parentElement;
    depth += 1;
  }
  return null;
}

/** Convenience predicate for call sites that don't need the container. */
export function isInStickyChrome(el: Element): boolean {
  return stickyChromeAncestor(el) !== null;
}
