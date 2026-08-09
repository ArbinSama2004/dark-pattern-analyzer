/**
 * Overlay badges in an isolated shadow root. See docs/ARCHITECTURE.md 4.3:
 * "closed shadow root with all: initial, so host-page CSS cannot break it
 * and your styles cannot break the host page."
 *
 * This was entirely missing in the delivered zip -- frontend/README.md
 * lists src/ui/ in the planned layout but no files existed under it.
 */
import type { ClassifyItemResult } from "../lib/messaging";

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
`;

interface MountedOverlay {
  update(items: ClassifyItemResult[]): void;
  destroy(): void;
}

export function mountOverlay(): MountedOverlay {
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

  function topFinding(item: ClassifyItemResult) {
    return item.findings[0]; // mergeFindings() already sorts by score desc
  }

  function render() {
    container.innerHTML = "";
    for (const item of current) {
      const el = document.querySelector(item.selector);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      // Skip elements currently scrolled out of the viewport entirely --
      // a badge positioned off-screen is not just wasted, it can also throw
      // off layout when it re-enters, and there's nothing to click on yet.
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

      const finding = topFinding(item);
      if (!finding) continue;

      const badge = document.createElement("div");
      badge.className = `badge ${finding.confidence}`;
      // Anchor near the top-left corner, not top-right (rect.right). Wide
      // block-level elements -- a product description paragraph, a full-row
      // bullet list item -- can be nearly viewport-width, which pushed the
      // badge off-screen or far from the text it actually describes. Clamp
      // both axes so the badge always stays visible even for elements that
      // start near an edge.
      const BADGE_APPROX_WIDTH = 140;
      const BADGE_APPROX_HEIGHT = 20;
      const top = Math.min(
        Math.max(rect.top, 4),
        window.innerHeight - BADGE_APPROX_HEIGHT - 4,
      );
      const left = Math.min(
        Math.max(rect.left, 4),
        window.innerWidth - BADGE_APPROX_WIDTH - 4,
      );
      badge.style.top = `${top}px`;
      badge.style.left = `${left}px`;
      badge.textContent =
        item.findings.length > 1
          ? `⚠ ${finding.label.replace(/_/g, " ")} +${item.findings.length - 1}`
          : `⚠ ${finding.label.replace(/_/g, " ")}`;
      badge.title = finding.description;
      badge.addEventListener("click", () => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        highlight(el);
      });
      container.appendChild(badge);
    }
  }

  function highlight(el: Element) {
    if (!(el instanceof HTMLElement)) return;
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = "2px solid #ea580c";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, 1500);
  }

  const onScrollOrResize = () => render();
  window.addEventListener("scroll", onScrollOrResize, { passive: true, capture: true });
  window.addEventListener("resize", onScrollOrResize, { passive: true });

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => render());
    resizeObserver.observe(document.body);
  }

  return {
    update(items: ClassifyItemResult[]) {
      current = items;
      render();
    },
    destroy() {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      resizeObserver?.disconnect();
      host.remove();
    },
  };
}

/** Scrolls to and highlights the element behind a finding -- used to handle
 * the side panel's "dp/scroll-to" message (docs/ARCHITECTURE.md 4.3:
 * "click-to-scroll-and-highlight action"). */
export function scrollAndHighlight(selector: string): void {
  const el = document.querySelector(selector);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (!(el instanceof HTMLElement)) return;
  const prevOutline = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = "2px solid #ea580c";
  el.style.outlineOffset = "2px";
  setTimeout(() => {
    el.style.outline = prevOutline;
    el.style.outlineOffset = prevOffset;
  }, 1500);
}
