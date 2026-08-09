import type { Rule } from "./types";

/**
 * A cancel/unsubscribe control that routes off the page entirely -- to a
 * phone number, an email compose window, or a different site -- instead of
 * handling cancellation in-product. See docs/ARCHITECTURE.md 4.5.
 */
export const cancelOffsite: Rule = (candidate, el) => {
  if (candidate.role !== "decline") return [];
  if (!(el instanceof HTMLAnchorElement)) return [];

  const href = el.getAttribute("href") ?? "";
  if (!href) return [];

  if (/^(tel:|mailto:)/i.test(href)) {
    return [{ rule: "cancel_offsite", label: "obstruction" }];
  }

  try {
    const resolved = new URL(href, location.href);
    if (resolved.origin !== location.origin) {
      return [{ rule: "cancel_offsite", label: "obstruction" }];
    }
  } catch {
    // Unparseable href (e.g. "javascript:void(0)") -- not an offsite route.
    return [];
  }

  return [];
};
