/**
 * Overlay badges in an isolated shadow root. See docs/ARCHITECTURE.md 4.3:
 * "closed shadow root with all: initial, so host-page CSS cannot break it
 * and your styles cannot break the host page."
 *
 * This was entirely missing in the delivered zip -- frontend/README.md
 * lists src/ui/ in the planned layout but no files existed under it.
 */
import type { ClassifyItemResult } from "../lib/messaging";
import { stickyChromeAncestor } from "../lib/extract/sticky";

const HOST_ID = "dark-pattern-analyzer-overlay-host";

const BADGE_STYLE = `
  :host { all: initial; }
  .badge {
    position: fixed;
    z-index: 2147483647;
    font: 12px/1.2 system-ui, sans-serif;
    background: #7c2d12;
    color: #fffbeb;
    border-radius: 9999px;
    padding: 2px 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    cursor: pointer;
    pointer-events: auto;
    white-space: nowrap;
    transform: translateY(-100%);
  }
  .badge:hover { background: #9a3412; }
  .badge.likely { background: #7c2d12; }
  .badge.possible { background: #78716c; }
  /* Pinned state: the badge stays visually "pressed" for as long as its
     target element is outlined, so the toggle has a visible affordance. */
  .badge.active {
    background: #ea580c;
    box-shadow: 0 0 0 2px #fffbeb, 0 1px 4px rgba(0, 0, 0, 0.5);
  }
`;

const HIGHLIGHT_OUTLINE = "2px solid #ea580c";
const HIGHLIGHT_OFFSET = "2px";
const TRANSIENT_HIGHLIGHT_MS = 1500;

const BADGE_APPROX_WIDTH = 140;
const BADGE_APPROX_HEIGHT = 20;

interface MountedOverlay {
  update(items: ClassifyItemResult[]): void;
  /** Re-run positioning/resolution against the current DOM without changing
   * the item set. Called by content.ts after every extraction pass, because
   * that pass is what refreshes the id -> live element registry after an SPA
   * re-render; without it, badges for re-rendered nodes stay missing until
   * the user happens to scroll. */
  refresh(): void;
  destroy(): void;
}

/**
 * `resolveElement` lets the caller supply a live element for an item (e.g.
 * from an id -> Element registry built during the same extraction pass)
 * instead of relying purely on `item.selector` here. This matters on
 * heavily re-rendering SPAs: `stableSelector()` is a positional CSS path
 * computed once at extraction time, and by the time a classify response
 * comes back (can be several seconds later under slow fp32 CPU inference),
 * a framework re-render can have changed sibling order/count enough that
 * the selector no longer resolves to the right node -- or to anything.
 * `querySelector(item.selector)` is kept as the fallback for callers that
 * don't track live elements (e.g. results rehydrated from storage).
 */
export function mountOverlay(
  resolveElement?: (item: ClassifyItemResult) => Element | null,
): MountedOverlay {
  const existing = document.getElementById(HOST_ID);
  existing?.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = BADGE_STYLE;
  shadow.appendChild(style);

  const container = document.createElement("div");
  shadow.appendChild(container);

  let current: ClassifyItemResult[] = [];
  let resizeObserver: ResizeObserver | null = null;
  let rafHandle: number | null = null;
  let destroyed = false;

  /**
   * Ids whose target element is currently outlined. Keyed by *item id*, not
   * by element, on purpose: on an SPA the underlying node can be swapped for
   * a fresh one between renders, and the user's intent ("keep this finding
   * highlighted") belongs to the finding, not to the DOM node that happened
   * to back it when they clicked.
   */
  const pinnedIds = new Set<string>();
  /** Elements we have written inline outline styles onto, with the values we
   * clobbered, so the host page's own styling is restored exactly on unpin. */
  const outlined = new Map<HTMLElement, { outline: string; offset: string }>();

  function applyOutline(el: Element): void {
    if (!(el instanceof HTMLElement)) return;
    if (outlined.has(el)) return;
    outlined.set(el, { outline: el.style.outline, offset: el.style.outlineOffset });
    el.style.outline = HIGHLIGHT_OUTLINE;
    el.style.outlineOffset = HIGHLIGHT_OFFSET;
  }

  function removeOutline(el: HTMLElement): void {
    const prev = outlined.get(el);
    if (!prev) return;
    el.style.outline = prev.outline;
    el.style.outlineOffset = prev.offset;
    outlined.delete(el);
  }

  /** Drop outlines from every element that is either no longer pinned or has
   * been detached by a re-render. Called at the start of each render so the
   * set of outlined nodes always tracks the live DOM. */
  function reconcileOutlines(pinnedElements: Set<HTMLElement>): void {
    for (const el of [...outlined.keys()]) {
      if (!pinnedElements.has(el) || !el.isConnected) removeOutline(el);
    }
  }

  function clearAllPins(): void {
    pinnedIds.clear();
    for (const el of [...outlined.keys()]) removeOutline(el);
    scheduleRender();
  }

  function topFinding(item: ClassifyItemResult) {
    return item.findings[0]; // mergeFindings() already sorts by score desc
  }

  function render() {
    if (destroyed) return;
    // An SPA route change can wipe subtrees wholesale; re-attach rather than
    // silently stop rendering if something took our host with it.
    if (!host.isConnected) document.documentElement.appendChild(host);

    container.innerHTML = "";
    // Debug trail: window.__dpRenderDebug after any update() shows exactly
    // why each item did or didn't get a badge -- no element found, not
    // attached to the document, zero-size, off-screen right now, or anchored
    // to pinned page chrome. Kept as a plain array assigned each render, not
    // appended, so it never grows unbounded.
    const debug: Array<{
      id: string;
      text: string;
      status:
        | "no-element"
        | "disconnected"
        | "zero-size"
        | "off-screen"
        | "sticky-chrome"
        | "rendered";
      rect?: { top: number; left: number; width: number; height: number };
    }> = [];

    // Boxes already occupied this frame, so badges anchored to nearby (or
    // identically clamped) elements stack instead of printing on top of each
    // other. Without this, several findings landing near the same corner
    // render as one unreadable smear.
    const placed: Array<{ top: number; left: number }> = [];
    const pinnedElements = new Set<HTMLElement>();

    for (const item of current) {
      const el = resolveElement?.(item) ?? document.querySelector(item.selector);
      if (!el) {
        debug.push({ id: item.id, text: item.text, status: "no-element" });
        continue;
      }
      if (!el.isConnected) {
        debug.push({ id: item.id, text: item.text, status: "disconnected" });
        continue;
      }
      // Safety net for items that predate the extraction-side filter --
      // results rehydrated from chrome.storage.session, or cached by the
      // backend before this build. Anchoring a badge to pinned chrome
      // produces a badge welded to the top-left corner while scrolling.
      if (stickyChromeAncestor(el)) {
        debug.push({ id: item.id, text: item.text, status: "sticky-chrome" });
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        debug.push({ id: item.id, text: item.text, status: "zero-size" });
        continue;
      }
      // Skip elements currently scrolled out of the viewport entirely --
      // a badge positioned off-screen is not just wasted, it can also throw
      // off layout when it re-enters, and there's nothing to click on yet.
      // Both axes: an element parked off to the side (carousel slide, closed
      // drawer) used to have its badge clamped back into the corner, which
      // looked exactly like a stuck badge.
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      ) {
        debug.push({
          id: item.id,
          text: item.text,
          status: "off-screen",
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        });
        continue;
      }

      const finding = topFinding(item);
      if (!finding) continue;
      debug.push({
        id: item.id,
        text: item.text,
        status: "rendered",
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      });

      const badge = document.createElement("div");
      const isPinned = pinnedIds.has(item.id);
      badge.className = `badge ${finding.confidence}${isPinned ? " active" : ""}`;
      if (isPinned) {
        applyOutline(el);
        if (el instanceof HTMLElement) pinnedElements.add(el);
      }
      // Anchor near the top-left corner, not top-right (rect.right). Wide
      // block-level elements -- a product description paragraph, a full-row
      // bullet list item -- can be nearly viewport-width, which pushed the
      // badge off-screen or far from the text it actually describes. Clamp
      // both axes so the badge always stays visible even for elements that
      // start near an edge.
      const { top, left } = avoidCollisions(
        Math.min(Math.max(rect.top, 4), window.innerHeight - BADGE_APPROX_HEIGHT - 4),
        Math.min(Math.max(rect.left, 4), window.innerWidth - BADGE_APPROX_WIDTH - 4),
        placed,
      );
      placed.push({ top, left });
      badge.style.top = `${top}px`;
      badge.style.left = `${left}px`;
      badge.textContent =
        item.findings.length > 1
          ? `⚠ ${finding.label.replace(/_/g, " ")} +${item.findings.length - 1}`
          : `⚠ ${finding.label.replace(/_/g, " ")}`;
      badge.title = `${finding.description}\n(click to toggle the highlight on this element)`;
      badge.addEventListener("click", (event) => {
        event.stopPropagation();
        if (pinnedIds.has(item.id)) {
          pinnedIds.delete(item.id);
        } else {
          pinnedIds.add(item.id);
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        scheduleRender();
      });
      container.appendChild(badge);
    }

    reconcileOutlines(pinnedElements);
    (window as unknown as Record<string, unknown>).__dpRenderDebug = debug;
  }

  /** Nudges a badge down until it no longer overlaps one already placed this
   * frame. Bounded so a page with dozens of co-located findings degrades to
   * overlapping badges rather than a badge column running off the screen. */
  function avoidCollisions(
    top: number,
    left: number,
    placed: Array<{ top: number; left: number }>,
  ): { top: number; left: number } {
    const step = BADGE_APPROX_HEIGHT + 4;
    let candidateTop = top;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const clash = placed.some(
        (p) =>
          Math.abs(p.top - candidateTop) < BADGE_APPROX_HEIGHT &&
          Math.abs(p.left - left) < BADGE_APPROX_WIDTH,
      );
      if (!clash) break;
      candidateTop += step;
      if (candidateTop > window.innerHeight - BADGE_APPROX_HEIGHT - 4) {
        candidateTop = top;
        break;
      }
    }
    return { top: candidateTop, left };
  }

  /** Coalesce the render bursts that scroll/resize/mutation produce into one
   * per animation frame. The previous code re-built every badge synchronously
   * on each scroll event, which on a long Daraz listing meant hundreds of
   * full innerHTML rebuilds per second. */
  function scheduleRender() {
    if (destroyed || rafHandle !== null) return;
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    rafHandle = raf(() => {
      rafHandle = null;
      render();
    }) as unknown as number;
  }

  const onScrollOrResize = () => scheduleRender();
  window.addEventListener("scroll", onScrollOrResize, { passive: true, capture: true });
  window.addEventListener("resize", onScrollOrResize, { passive: true });

  // Click-away clears every pinned highlight. The shadow root is closed, so
  // clicks originating inside it retarget to the host element -- that check is
  // what distinguishes "clicked a badge" (handled by the badge's own listener)
  // from "clicked the page".
  const onDocumentClick = (event: MouseEvent) => {
    if (pinnedIds.size === 0) return;
    if (event.target === host) return;
    clearAllPins();
  };
  document.addEventListener("click", onDocumentClick, true);

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => scheduleRender());
    resizeObserver.observe(document.body);
  }

  return {
    update(items: ClassifyItemResult[]) {
      current = items;
      // Forget pins whose finding is gone from the current result set, so the
      // outlined-element bookkeeping can't leak across page navigations.
      const liveIds = new Set(items.map((i) => i.id));
      for (const id of [...pinnedIds]) if (!liveIds.has(id)) pinnedIds.delete(id);
      console.log(`[dark-pattern-analyzer] overlay.update: ${items.length} item(s)`);
      scheduleRender();
    },
    refresh() {
      scheduleRender();
    },
    destroy() {
      destroyed = true;
      for (const el of [...outlined.keys()]) removeOutline(el);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      document.removeEventListener("click", onDocumentClick, true);
      resizeObserver?.disconnect();
      host.remove();
    },
  };
}

/** Scrolls to and briefly highlights the element behind a finding -- used to
 * handle the side panel's "dp/scroll-to" message (docs/ARCHITECTURE.md 4.3:
 * "click-to-scroll-and-highlight action"). Deliberately still a transient
 * flash: unlike an overlay badge there is no on-page control to click a
 * second time to turn it back off. */
export function scrollAndHighlight(selector: string): void {
  let el: Element | null = null;
  try {
    el = document.querySelector(selector);
  } catch {
    // A selector captured before a re-render can be syntactically fine but
    // unresolvable, or (rarely) malformed after CSS.escape edge cases.
    el = null;
  }
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (!(el instanceof HTMLElement)) return;
  const prevOutline = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = HIGHLIGHT_OUTLINE;
  el.style.outlineOffset = HIGHLIGHT_OFFSET;
  setTimeout(() => {
    el!.style.outline = prevOutline;
    (el as HTMLElement).style.outlineOffset = prevOffset;
  }, TRANSIENT_HIGHLIGHT_MS);
}
