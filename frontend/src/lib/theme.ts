/**
 * Light / dark appearance for the extension's own surfaces (popup and side
 * panel). The on-page overlay is deliberately not covered: it renders inside a
 * closed shadow root with `all: initial` over someone else's page, and its
 * colours are a legibility contract with that page, not with Chrome's theme.
 *
 * Three choices, not two. "System" has to exist and has to be the default --
 * a browser UI that ignores the OS setting reads as broken, and a user who has
 * never opened the settings block should still get a dark panel on a dark
 * desktop. Light and dark are the explicit overrides for the people whose
 * preference differs from their OS.
 *
 * Applied as a `dark` class on the document element (Tailwind's `darkMode:
 * "class"`), plus a matching `color-scheme` so form controls, scrollbars and
 * focus rings -- which Tailwind cannot reach -- follow too.
 */

import { loadSettings, onSettingsChanged, type Theme } from "./settings";

export type ResolvedTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

export function applyTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.classList.toggle("dark", resolved === "dark");
  // Tailwind styles what it renders; this styles what it doesn't -- native
  // checkboxes, the panel's scrollbar, and the default canvas colour behind
  // the React tree before it paints.
  root.style.colorScheme = resolved;
}

/** Does the OS ask for dark? False in any environment without matchMedia
 * (jsdom, an older runtime), which degrades to light rather than throwing. */
export function prefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY).matches
    : false;
}

/**
 * Wires the document to the stored theme preference, and returns a teardown.
 *
 * Call this before rendering. It applies the system-derived theme
 * *synchronously* first, then corrects once storage has been read: reading
 * chrome.storage is a round trip, and without the synchronous pass a dark
 * panel visibly flashes white on every open. The synchronous guess is right
 * for the default ("system") and for anyone whose override matches their OS;
 * it is wrong only for the deliberate mismatch, and only for one frame.
 */
export function initTheme(root: HTMLElement = document.documentElement): () => void {
  applyTheme(root, resolveTheme("system", prefersDark()));

  let current: Theme = "system";
  const render = () => applyTheme(root, resolveTheme(current, prefersDark()));

  void loadSettings().then((settings) => {
    current = settings.theme;
    render();
  });

  const unsubscribeSettings = onSettingsChanged((settings) => {
    current = settings.theme;
    render();
  });

  // Only matters while the preference is "system", but subscribing
  // unconditionally keeps it correct if the user switches back to system
  // after the OS has changed underneath.
  const media =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(DARK_QUERY)
      : null;
  media?.addEventListener("change", render);

  return () => {
    unsubscribeSettings();
    media?.removeEventListener("change", render);
  };
}
