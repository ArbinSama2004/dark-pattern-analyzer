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
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .badge:hover { background: #9a3412; }
  .badge.likely { background: #7c2d12; }
  .badge.possible { background: #78716c; }
  /* Collapsed form: the warning glyph only, no label text. Used when the
     full-width badge could not be placed without covering rendered page text
     (see chooseBadgePosition) -- an icon roughly a fifth the width usually
     fits in a gutter where the labelled form does not. Hovering restores the
     label, so the information is one pointer-move away rather than lost. */
  .badge.collapsed { padding: 2px 5px; }
  .badge.collapsed .label { display: none; }
  .badge.collapsed:hover .label { display: inline; }
  /* Pinned state: the badge stays visually "pressed" for as long as its
     target element is outlined, so the toggle has a visible affordance. */
  .badge.active {
    background: #ea580c;
    box-shadow: 0 0 0 2px #fffbeb, 0 1px 4px rgba(0, 0, 0, 0.5);
  }
  .badge.active .label { display: inline; }
`;

const HIGHLIGHT_OUTLINE = "2px solid #ea580c";
const HIGHLIGHT_OFFSET = "2px";
const TRANSIENT_HIGHLIGHT_MS = 1500;

/** Clearance kept between a badge and whatever it's placed next to -- the
 * target it's labeling, or another badge. Without this, a badge's edge sits
 * flush against the adjacent content with zero breathing room, which on a
 * dense list (search results, product grid) reads as the badge "covering"
 * the neighboring row's text. */
const BADGE_GAP = 6;

/** How far above and below a target to look for text the badge might cover.
 * Comfortably more than one badge height plus its gap, so both the "above"
 * and "below" candidates are fully inside the searched region. */
const VERTICAL_SEARCH_MARGIN = 60;

/** Cap on text nodes examined per badge per render. A product card holds a
 * few dozen; this only bites on pathological markup, where placement degrades
 * to "considers the first N text runs" rather than stalling a render. */
const MAX_TEXT_NODES_SCANNED = 400;

/** A viewport-space rectangle. Structurally compatible with DOMRect for the
 * four edges we actually use, so real `getBoundingClientRect()` results and
 * plain test fixtures both satisfy it. */
export interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** Area of the overlap between two boxes; 0 when they don't intersect. Used
 * as the penalty currency in chooseBadgePosition -- "how much does this
 * placement cover" is a far more useful signal than the old boolean
 * "does it collide at all", because in a dense price block *every* candidate
 * position collides with something and the job is to pick the least bad. */
export function intersectionArea(a: Box, b: Box): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

/** Overlapping another one of our own badges is worse than overlapping page
 * text: two stacked badges are mutually illegible, whereas a badge clipping
 * the edge of a text run is merely untidy. Weighted rather than forbidden so
 * a genuinely saturated cluster still resolves to *some* position instead of
 * failing to place. */
const PLACED_BADGE_PENALTY_WEIGHT = 8;

/** How much of a nuisance a badge at `box` would be: the area of page text it
 * covers, plus a weighted area of any already-placed badge it collides with.
 * 0 means a genuinely clear slot. Exported so the caller can compare a
 * labelled placement against a collapsed one and keep the better of the two
 * (see render()), not just to be tested in isolation. */
export function positionPenalty(box: Box, obstacles: Box[], placed: Box[]): number {
  let penalty = 0;
  for (const obstacle of obstacles) penalty += intersectionArea(box, obstacle);
  for (const other of placed) {
    penalty += PLACED_BADGE_PENALTY_WEIGHT * intersectionArea(box, other);
  }
  return penalty;
}

/**
 * Picks the least-obstructive position for a badge of a known size around a
 * known target.
 *
 * This replaces the previous "above, else below, then nudge down up to 24
 * times" strategy, which had two failure modes visible on real pages:
 * it only ever considered two positions (both vertical, so a badge in a
 * tight vertical space had nowhere to go), and it treated collision as a
 * boolean -- when both positions collided it kept the first one regardless
 * of which actually covered less.
 *
 * Every candidate is clamped into the viewport *before* scoring, so the
 * returned box is always fully on-screen and the score reflects where the
 * badge will really land rather than where it would have landed unclamped.
 *
 * `obstacles` are boxes worth avoiding (rendered text runs, see
 * textRectsNear); `placed` are badges already positioned this pass.
 */
export function chooseBadgePosition(
  target: Box,
  size: { width: number; height: number },
  obstacles: Box[],
  placed: Box[],
  viewport: { width: number; height: number },
): Box {
  const { width, height } = size;
  // Ordered by preference. Above/below the target read as labelling it;
  // beside it is the fallback that saves badges in vertically-tight rows
  // (a price line sandwiched between two others), which is exactly the
  // situation the old two-position strategy could not escape.
  const candidates: Array<{ top: number; left: number }> = [
    { top: target.top - BADGE_GAP - height, left: target.left },
    { top: target.top - BADGE_GAP - height, left: target.right - width },
    { top: target.bottom + BADGE_GAP, left: target.left },
    { top: target.bottom + BADGE_GAP, left: target.right - width },
    { top: target.top, left: target.right + BADGE_GAP },
    { top: target.top, left: target.left - BADGE_GAP - width },
  ];

  let best: Box | null = null;
  let bestPenalty = Infinity;

  for (const [index, candidate] of candidates.entries()) {
    const left = Math.min(Math.max(candidate.left, 4), Math.max(4, viewport.width - width - 4));
    const top = Math.min(Math.max(candidate.top, 4), Math.max(4, viewport.height - height - 4));
    const box: Box = { top, left, right: left + width, bottom: top + height };

    // Tiny tiebreak so that among equally-clean positions the earlier (more
    // preferred) one wins, instead of depending on iteration order by luck.
    const penalty = positionPenalty(box, obstacles, placed) + index * 0.01;

    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = box;
    }
    if (bestPenalty < 0.01) break; // a genuinely clear slot; stop looking
  }

  // candidates is a non-empty literal, so the loop always assigns `best`.
  return best!;
}

interface MountedOverlay {
  update(items: ClassifyItemResult[]): void;
  /** Re-run positioning/resolution against the current DOM without changing
   * the item set. Called by content.ts after every extraction pass, because
   * that pass is what refreshes the id -> live element registry after an SPA
   * re-render; without it, badges for re-rendered nodes stay missing until
   * the user happens to scroll. */
  refresh(): void;
  /** Show or hide every badge without discarding the findings behind them.
   * Hiding is a pure display concern -- `current` is untouched, so flipping
   * it back on re-renders instantly from state already in hand rather than
   * waiting on a re-scan. */
  setVisible(visible: boolean): void;
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
  let visible = true;
  let lastLoggedDebugSignature = "";

  /**
   * Ids whose target element is currently outlined. Keyed by *item id*, not
   * by element, on purpose: on an SPA the underlying node can be swapped for
   * a fresh one between renders, and the user's intent ("keep this finding
   * highlighted") belongs to the finding, not to the DOM node that happened
   * to back it when they clicked.
   */
  const pinnedIds = new Set<string>();

  /**
   * Ids whose badge has been collapsed to its icon-only form.
   *
   * Sticky on purpose. The labelled/collapsed choice depends on what text
   * currently surrounds the target, and that changes constantly while a page
   * settles -- images finishing load, lazy rows appearing, fonts swapping.
   * Recomputing it per render made badges visibly oscillate between the full
   * label and the icon, which reads as flickering. Deciding once per finding
   * and keeping it is stable, and the cost of being wrong is small: a badge
   * that could have shown its label stays an icon until the next page load.
   */
  const collapsedIds = new Set<string>();
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
   * Viewport rectangles of the actual rendered *text runs* in and around the
   * target -- the things a badge must not sit on top of.
   *
   * This replaces a previous boolean `overlapsForeignContent()` check that
   * sampled `document.elementFromPoint()` and exempted anything in an
   * ancestor/descendant relationship with the target, on the reasoning that
   * "this is what the badge is labelling, not something it would obscure."
   * That exemption is what let the reported bug through: when the resolved
   * target is a *container* (a whole price block) rather than a leaf, the
   * current-price text inside it is a descendant, so covering it was
   * explicitly permitted. An ancestor hit is just as bad -- text belonging to
   * a wrapping element that also contains the target got the same free pass.
   *
   * Working in text rectangles instead of element hit-testing sidesteps the
   * whole question of who is related to whom: rendered glyphs are never
   * acceptable to cover, and empty padding/background always is. That also
   * means a badge can legitimately tuck into a target's own whitespace,
   * which the old element-level check could never allow.
   *
   * Collected by walking the text nodes of a bounded ancestor and keeping the
   * rectangles that fall in the region the badge could actually occupy.
   *
   * An earlier version hit-tested a ring of eight sample points around the
   * target instead, and missed the exact case this was written for. On a Daraz
   * product card the flagged element is the discount ("-69%", ~48px wide) but
   * the badge is ~140px wide, and the current price ("Rs.295") sits to its
   * *left*. Every probe was taken at the target's own x-range, where there is
   * nothing but card background -- so the price registered as no obstacle, the
   * "above" position scored a clean zero, and the badge was placed straight
   * over the price. Point sampling around a small target cannot see what a
   * much wider badge will cover; the search region has to be the size of the
   * badge, not the size of the target.
   */
  function textRectsNear(target: Element, targetRect: DOMRect, badgeWidth: number): Box[] {
    // The region any candidate position could land in: a badge-width margin
    // either side, and enough above/below for the vertical placements.
    const region: Box = {
      top: targetRect.top - VERTICAL_SEARCH_MARGIN,
      bottom: targetRect.bottom + VERTICAL_SEARCH_MARGIN,
      left: targetRect.left - badgeWidth - BADGE_GAP,
      right: targetRect.right + badgeWidth + BADGE_GAP,
    };

    // Climb to an ancestor that plausibly contains the whole local layout
    // block (the product card, the price block), so the walk below sees the
    // neighbouring rows. Bounded: without a cap this reaches <body> on a
    // shallow page and the walk stops being affordable.
    let container: Element = target;
    for (let depth = 0; depth < 4; depth += 1) {
      const parent = container.parentElement;
      if (!parent) break;
      container = parent;
      const rect = parent.getBoundingClientRect();
      if (rect.width >= region.right - region.left && rect.height >= targetRect.height) {
        break;
      }
    }

    const rects: Box[] = [];
    let scanned = 0;
    try {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      for (
        let node = walker.nextNode();
        node && scanned < MAX_TEXT_NODES_SCANNED;
        node = walker.nextNode()
      ) {
        scanned += 1;
        if (!(node.textContent ?? "").trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          // Only what the badge could plausibly reach. Rects outside the
          // region cannot affect any candidate's score, and carrying them
          // would make the scoring loop proportional to card size.
          if (intersectionArea(rect, region) > 0) rects.push(rect);
        }
      }
    } catch {
      // A subtree mutated mid-walk (SPA re-render). Whatever was collected so
      // far is still valid; placement degrades, it does not fail.
    }
    return rects;
  }

  function render() {
    if (destroyed) return;
    // An SPA route change can wipe subtrees wholesale; re-attach rather than
    // silently stop rendering if something took our host with it.
    if (!host.isConnected) document.documentElement.appendChild(host);

    container.innerHTML = "";

    // Hidden: the container is already emptied above, and every pinned
    // outline has to come off with the badges -- leaving a page element
    // outlined with no badge to un-pin it would strand the user with a
    // highlight they have no control to remove. `current` is deliberately
    // left intact so setVisible(true) can re-render without a re-scan.
    if (!visible) {
      for (const el of [...outlined.keys()]) removeOutline(el);
      return;
    }

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

    const placedBoxes: Box[] = [];
    const viewport = { width: window.innerWidth, height: window.innerHeight };

    // Phase 1: build every badge element and attach it, hidden. Nothing can
    // be positioned until it has been measured, and nothing can be measured
    // until it is in the document -- the previous code sidestepped this with
    // hardcoded BADGE_APPROX_WIDTH/HEIGHT constants (140x20), but the real
    // rendered badge is whatever the label text makes it. "false urgency"
    // alone overflows 140px, so every collision decision was being made
    // against a box narrower than the thing actually drawn, which is part of
    // why badges still overlapped after collision handling "passed".
    interface Pending {
      item: ClassifyItemResult;
      el: Element;
      rect: DOMRect;
      badge: HTMLElement;
    }
    const pending: Pending[] = [];

    for (const { item, el, finding, rect } of placeable) {
      const badge = document.createElement("div");
      const isPinned = pinnedIds.has(item.id);
      badge.className = `badge ${finding.confidence}${isPinned ? " active" : ""}`;
      if (isPinned) {
        applyOutline(el);
        if (el instanceof HTMLElement) pinnedElements.add(el);
      }

      const glyph = document.createElement("span");
      glyph.textContent = "⚠";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent =
        item.findings.length > 1
          ? `${finding.label.replace(/_/g, " ")} +${item.findings.length - 1}`
          : finding.label.replace(/_/g, " ");
      badge.append(glyph, label);

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

      // Hidden, not display:none -- it has to participate in layout to have
      // a measurable size, but must not flash at position 0,0 before phase 2
      // assigns it a real one.
      badge.style.visibility = "hidden";
      container.appendChild(badge);
      pending.push({ item, el, rect, badge });
    }

    // Phase 2: measure, place, reveal. Sequential rather than batched because
    // each placement depends on where the previous ones landed (placedBoxes).
    for (const { item, el, rect, badge } of pending) {
      // Already decided to be an icon on an earlier render -- honour that
      // rather than re-deriving it from a layout that has since shifted.
      const alreadyCollapsed = collapsedIds.has(item.id);
      if (alreadyCollapsed) badge.classList.add("collapsed");

      // Measured first: the obstacle search region is sized by the badge, not
      // the target, because a wide badge covers content well outside a small
      // target's own bounds -- see textRectsNear.
      const labelled = { width: badge.offsetWidth, height: badge.offsetHeight };
      const obstacles = textRectsNear(el, rect, labelled.width);
      let box = chooseBadgePosition(rect, labelled, obstacles, placedBoxes, viewport);
      let penalty = positionPenalty(box, obstacles, placedBoxes);

      // Nowhere clean for the full-width labelled badge. Try the icon-only
      // form, which is roughly a fifth the width and often fits a gutter the
      // labelled one cannot -- but only keep it if it genuinely covers less,
      // so badges stay readable wherever there is actually room for them.
      // This is the adaptive half of the fix: the old code had one fixed
      // badge size and no recourse when it didn't fit anywhere.
      if (penalty > 0 && !alreadyCollapsed) {
        badge.classList.add("collapsed");
        const collapsed = { width: badge.offsetWidth, height: badge.offsetHeight };
        const collapsedBox = chooseBadgePosition(
          rect,
          collapsed,
          obstacles,
          placedBoxes,
          viewport,
        );
        const collapsedPenalty = positionPenalty(collapsedBox, obstacles, placedBoxes);
        if (collapsedPenalty < penalty) {
          box = collapsedBox;
          penalty = collapsedPenalty;
          collapsedIds.add(item.id);
        } else {
          badge.classList.remove("collapsed");
        }
      }

      placedBoxes.push(box);
      badge.style.top = `${box.top}px`;
      badge.style.left = `${box.left}px`;
      badge.style.visibility = "visible";
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
      // Same bookkeeping for the sticky collapsed set, so it can't grow
      // without bound across a long-lived tab or carry a decision from a
      // previous page onto a new one.
      for (const id of [...collapsedIds]) if (!liveIds.has(id)) collapsedIds.delete(id);
      console.log(`[dark-pattern-analyzer] overlay.update: ${items.length} item(s)`);
      scheduleRender();
    },
    refresh() {
      scheduleRender();
    },
    setVisible(next: boolean) {
      if (next === visible) return;
      visible = next;
      console.log(`[dark-pattern-analyzer] overlay ${next ? "shown" : "hidden"}`);
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
