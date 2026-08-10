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
/** Vertical clearance kept between a badge and whatever it's placed next to
 * -- the target it's labeling, or another badge. Without this, a badge's
 * edge sits flush against the adjacent content with zero breathing room,
 * which on a dense list (search results, product grid) reads as the badge
 * "covering" the neighboring row's text. */
const BADGE_GAP = 6;
/** Bounded settle pass for pushing a badge below whatever it overlaps.
 * Re-scans every already-placed box on each attempt (not just the one that
 * caused the last push), so a chain of three or four co-located findings
 * still resolves to a clean stack instead of colliding after the first
 * nudge. */
const MAX_SETTLE_ATTEMPTS = 24;

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
  let lastLoggedDebugSignature = "";

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

  /**
   * True if the proposed badge box would visually cover real, unrelated
   * page content -- not the badge's own target, not our own overlay (other
   * badges are handled by the settle pass in render(), not here).
   * Sample-point based rather than exhaustive: a handful of points along the
   * box's edges is enough to catch "this lands on top of a price row" while
   * staying cheap enough to run per badge per render.
   */
  function overlapsForeignContent(
    top: number,
    left: number,
    right: number,
    bottom: number,
    target: Element,
  ): boolean {
    const samplePoints: Array<[number, number]> = [
      [left + 4, top + 2],
      [right - 4, top + 2],
      [left + 4, bottom - 2],
      [right - 4, bottom - 2],
      [(left + right) / 2, (top + bottom) / 2],
    ];
    for (const [x, y] of samplePoints) {
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      const found = document.elementFromPoint(x, y);
      if (!found) continue;
      // Our own overlay host (a closed shadow root is opaque to
      // elementFromPoint from outside, so another one of our own badges
      // reports as the host, not itself) -- not foreign, and already
      // handled by the badge-vs-badge settle pass.
      if (found === host) continue;
      // The target's own content, or an ancestor/descendant of it -- this
      // is what the badge is *labeling*, not something it would obscure.
      if (found === target || target.contains(found) || found.contains(target)) continue;
      return true;
    }
    return false;
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
        | "rendered"
        | "error";
      rect?: { top: number; left: number; width: number; height: number };
    }> = [];

    // First pass: resolve every item to a placeable {el, rect, finding}
    // entry, applying every existing filter (no-element, disconnected,
    // sticky chrome, zero-size, off-screen) exactly as before. Positioning
    // happens in a second pass, over entries sorted by document position --
    // that ordering is what makes the collision settle-pass below behave
    // predictably instead of depending on `current`'s arbitrary array order.
    interface Placeable {
      item: ClassifyItemResult;
      el: Element;
      finding: ClassifyItemResult["findings"][number];
      rect: DOMRect;
    }
    const placeable: Placeable[] = [];
    const pinnedElements = new Set<HTMLElement>();

    for (const item of current) {
      // The whole point of clearing `container` before this loop runs is to
      // rebuild it fresh -- which means an uncaught exception from any one
      // item (a stale item.tag surviving a chrome.storage.session entry
      // written before this field existed; any other future surprise) used
      // to abort the loop with the container already emptied and never
      // repopulated. Every subsequent scroll-triggered render hit the same
      // item and failed identically -- "badges disappear after scrolling
      // and never come back" was this, not a positioning bug. One item
      // failing must cost that one badge, not the whole overlay.
      try {
        renderOne(item);
      } catch (err) {
        debug.push({ id: item.id, text: item.text, status: "error" });
        console.error(
          `[dark-pattern-analyzer] overlay: failed to render item "${item.text}" (id=${item.id}) -- skipped, other badges unaffected.`,
          err,
        );
      }
    }

    function renderOne(item: ClassifyItemResult): void {
      const el = resolveElement?.(item) ?? document.querySelector(item.selector);
      if (!el) {
        debug.push({ id: item.id, text: item.text, status: "no-element" });
        return;
      }
      if (!el.isConnected) {
        debug.push({ id: item.id, text: item.text, status: "disconnected" });
        return;
      }
      // Safety net for items that predate the extraction-side filter --
      // results rehydrated from chrome.storage.session, or cached by the
      // backend before this build. Anchoring a badge to pinned chrome
      // produces a badge welded to the top-left corner while scrolling.
      if (stickyChromeAncestor(el)) {
        debug.push({ id: item.id, text: item.text, status: "sticky-chrome" });
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        debug.push({ id: item.id, text: item.text, status: "zero-size" });
        return;
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
        return;
      }

      const finding = topFinding(item);
      if (!finding) return;
      debug.push({
        id: item.id,
        text: item.text,
        status: "rendered",
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      });
      placeable.push({ item, el, finding, rect });
    }

    // Sort top-to-bottom (document/viewport order), so the settle pass below
    // always pushes a *later* badge down past an *earlier* one -- never the
    // reverse -- which is what keeps the stack visually coherent instead of
    // depending on whatever order `current` happened to list findings in.
    placeable.sort((a, b) => a.rect.top - b.rect.top);

    interface Box {
      top: number;
      bottom: number;
      left: number;
      right: number;
    }
    const placedBoxes: Box[] = [];

    for (const { item, el, finding, rect } of placeable) {
      const left = Math.min(
        Math.max(rect.left, 4),
        window.innerWidth - BADGE_APPROX_WIDTH - 4,
      );
      const right = left + BADGE_APPROX_WIDTH;

      // Prefer directly above the target, with real clearance (BADGE_GAP) --
      // not flush against it. If there isn't room above (the element sits
      // near the very top of the viewport), place below instead of clamping
      // upward into whatever content precedes it.
      let top = rect.top - BADGE_GAP - BADGE_APPROX_HEIGHT;
      let bottom = top + BADGE_APPROX_HEIGHT;
      if (top < 4) {
        top = rect.bottom + BADGE_GAP;
        bottom = top + BADGE_APPROX_HEIGHT;
      }

      // A gap large enough to clear the *target itself* can still be too
      // small to clear whatever sits directly above it -- a real bug caught
      // on a live page: a price block where the current-price row sat close
      // enough above the discount badge's target that the badge, placed
      // "above" per the rule just above, landed on top of the price digits
      // instead. If the proposed box actually covers unrelated rendered
      // content, flip to below the target instead.
      if (overlapsForeignContent(top, left, right, bottom, el)) {
        const belowTop = rect.bottom + BADGE_GAP;
        const belowBottom = belowTop + BADGE_APPROX_HEIGHT;
        // Only switch if below is actually clearer -- an equally-cramped
        // "below" is no improvement, and the settle pass further down still
        // needs *a* starting position even in a genuinely dense cluster.
        if (!overlapsForeignContent(belowTop, left, right, belowBottom, el)) {
          top = belowTop;
          bottom = belowBottom;
        }
      }

      // Settle pass: push straight down past anything already placed that
      // this box would overlap (both axes), re-checking from scratch each
      // attempt so a chain of several co-located findings still resolves to
      // a clean, non-overlapping stack rather than colliding after the first
      // nudge like the previous single-shot version did.
      for (let attempt = 0; attempt < MAX_SETTLE_ATTEMPTS; attempt += 1) {
        const clash = placedBoxes.find(
          (box) => left < box.right && right > box.left && top < box.bottom && bottom > box.top,
        );
        if (!clash) break;
        top = clash.bottom + BADGE_GAP;
        bottom = top + BADGE_APPROX_HEIGHT;
      }
      // Final viewport clamp in case a long settle chain pushed the badge
      // below the fold -- accepting a possible overlap here (rare: only on
      // an extremely dense cluster) is preferable to an invisible badge.
      if (bottom > window.innerHeight - 4) {
        bottom = window.innerHeight - 4;
        top = bottom - BADGE_APPROX_HEIGHT;
      }

      placedBoxes.push({ top, bottom, left, right });

      const badge = document.createElement("div");
      const isPinned = pinnedIds.has(item.id);
      badge.className = `badge ${finding.confidence}${isPinned ? " active" : ""}`;
      if (isPinned) {
        applyOutline(el);
        if (el instanceof HTMLElement) pinnedElements.add(el);
      }
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

    // Print the same data `window.__dpRenderDebug` holds, not just assign it.
    // Content scripts run in an isolated JS world (a separate `window` from
    // the page) -- DevTools' Console evaluates typed expressions like
    // `window.__dpRenderDebug` against whatever context is currently
    // selected in its context dropdown (defaults to the page's main world,
    // where this global doesn't exist), so "undefined" there does not mean
    // this never ran. console.log output, unlike a typed expression, is
    // always visible in the default console view regardless of that
    // dropdown -- so logging here is what actually reaches a user who hasn't
    // switched contexts. Deduped against the last logged signature so a
    // steady page (nothing changed) doesn't reprint on every scroll-driven
    // render.
    const signature = debug.map((d) => `${d.id}:${d.status}`).join("|");
    if (signature !== lastLoggedDebugSignature) {
      lastLoggedDebugSignature = signature;
      const byStatus = debug.reduce<Record<string, number>>((acc, d) => {
        acc[d.status] = (acc[d.status] ?? 0) + 1;
        return acc;
      }, {});
      console.log(
        `[dark-pattern-analyzer] render: ${debug.length} item(s) -- ${JSON.stringify(byStatus)}`,
        debug,
      );
    }
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
