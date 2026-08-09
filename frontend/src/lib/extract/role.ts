import { assertRole, FALLBACK_ROLE, type Role } from "../roles";

/**
 * Ordered heuristic: structural signals (tag, checkbox-ness, ancestry) take
 * priority over wording, then a per-language keyword match, then class/id
 * tokens, falling back to "body". See docs/ARCHITECTURE.md 4.1, "Role
 * inference".
 *
 * Every branch returns one of the 20 roles the model was actually trained
 * on (src/lib/roles.ts, generated from data/synthetic/dataset_all.csv) --
 * never an invented one. inferRole() asserts this on every call rather than
 * only in tests, since a role reaching the backend unseen fails silently
 * (see roles.ts for why that matters).
 *
 * Keyword tables are intentionally small and will grow. Keep them here (not
 * duplicated in the backend) -- the backend never needs role inference, it
 * only receives the already-inferred role as an input field.
 */
const DECLINE_KEYWORDS: Record<string, string[]> = {
  en: ["cancel", "no thanks", "decline", "skip", "not now", "maybe later"],
  hi: ["रद्द करें", "नहीं धन्यवाद", "अभी नहीं"],
  ne: ["रद्द गर्नुहोस्", "पछि", "अहिले होइन"],
};

const CTA_KEYWORDS: Record<string, string[]> = {
  en: ["buy", "add to cart", "checkout", "continue", "confirm", "subscribe", "get started"],
  hi: ["खरीदें", "जारी रखें", "अभी सदस्यता लें"],
  ne: ["किन्नुहोस्", "जारी राख्नुहोस्", "सदस्यता लिनुहोस्"],
};

const SUPPORT_KEYWORDS: Record<string, string[]> = {
  en: ["contact support", "contact us", "help center", "customer service"],
  hi: ["सहायता केंद्र", "हमसे संपर्क करें"],
  ne: ["सहायता केन्द्र", "हामीलाई सम्पर्क गर्नुहोस्"],
};

const FINE_PRINT_CLASS_RE =
  /fine-?print|disclaimer|legal|terms?[-_]?(and|&)?[-_]?conditions/i;
const BADGE_CLASS_RE = /\bbadge\b/i;
// Extended to cover Daraz/e-commerce opaque class names that contain the
// product discount suffix but don't spell out "promo" or "deal".
const PROMO_CLASS_RE = /promo|discount|deal|offer|pdp-discount|price-discount|deal-badge/i;
const TOAST_CLASS_RE = /toast|snackbar/i;
const MODAL_CLASS_RE = /modal|dialog|popup|overlay/i;
const HELP_CLASS_RE = /help|hint|tooltip/i;
const LINE_ITEM_CLASS_RE = /line-?item|cart-?item|price-?row|order-?item/i;
const STOCK_CLASS_RE = /stock|inventory/i;
const TIMER_CLASS_RE = /timer|countdown/i;
const BANNER_CLASS_RE = /banner|announcement/i;

/** Matches text that is unmistakably a discount badge regardless of class
 * name, e.g. "-8%", "15% off", "Save NPR 300", "₹200 off". */
const DISCOUNT_TEXT_RE = /^-\d+%$|^\d+%\s*off\b|\bsave\s+[\d,]+|\bsave\s+\d+%/i;

function normalizedText(el: Element): string {
  return (el.textContent ?? "").trim().toLowerCase();
}

function classAndId(el: Element): string {
  const cls = typeof el.className === "string" ? el.className : "";
  return `${cls} ${el.id ?? ""}`;
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => text.includes(kw.toLowerCase()));
}

function closest(el: Element, selector: string): Element | null {
  return typeof el.closest === "function" ? el.closest(selector) : null;
}

export function inferRole(el: Element, lang: string): Role {
  const accessibleName =
    el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "";
  const text = normalizedText(el) || accessibleName.toLowerCase();
  const tag = el.tagName.toLowerCase();
  const attrs = classAndId(el);

  const declineWords = DECLINE_KEYWORDS[lang] ?? DECLINE_KEYWORDS.en ?? [];
  const ctaWords = CTA_KEYWORDS[lang] ?? CTA_KEYWORDS.en ?? [];
  const supportWords = SUPPORT_KEYWORDS[lang] ?? SUPPORT_KEYWORDS.en ?? [];

  function decide(): string {
    // Structural roles that don't depend on wording take priority -- an
    // <input type="checkbox"> is a checkbox regardless of its label text.
    if (tag === "input" && (el as HTMLInputElement).type === "checkbox") {
      return "checkbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "nav" || el.getAttribute("role") === "navigation") return "nav";
    if (tag === "form") return "form";
    if (tag === "label" || closest(el, "label")) return "label";

    // A required field inside a form that gates progress.
    if (
      (tag === "input" || tag === "select" || tag === "textarea") &&
      (el as HTMLInputElement).required &&
      closest(el, "form")
    ) {
      return "form_gate";
    }

    if (closest(el, '[role="dialog"]') || MODAL_CLASS_RE.test(attrs)) {
      return "modal_text";
    }

    // Wording-based checks, most specific first.
    if (
      matchesAny(text, supportWords) ||
      (tag === "a" && /^(mailto:|tel:)/.test(el.getAttribute("href") ?? ""))
    ) {
      return "support_link";
    }
    if (matchesAny(text, declineWords)) return "decline";
    if (matchesAny(text, ctaWords)) return "cta";
    if (tag === "button" || el.getAttribute("role") === "button") {
      // A button matching neither wordlist -- still worth flagging
      // structurally as a generic accept-side control, since most
      // unclassified buttons on e-commerce pages are.
      return "cta";
    }

    if (
      FINE_PRINT_CLASS_RE.test(attrs) ||
      (el instanceof HTMLElement && parseFloat(getComputedStyle(el).fontSize) < 11)
    ) {
      return "fine_print";
    }
    if (TIMER_CLASS_RE.test(attrs) || /\b\d{1,2}:\d{2}(:\d{2})?\b/.test(text)) {
      return "timer";
    }
    if (STOCK_CLASS_RE.test(attrs)) return "stock";
    if (LINE_ITEM_CLASS_RE.test(attrs)) return "line_item";
    if (TOAST_CLASS_RE.test(attrs)) return "toast";
    if (HELP_CLASS_RE.test(attrs)) return "help_text";
    if (BADGE_CLASS_RE.test(attrs)) return "badge";
    // Text-first: a discount percentage or "save N" phrase is unambiguously
    // promotional regardless of what CSS class the site happened to use.
    if (DISCOUNT_TEXT_RE.test(text)) return "promo";
    if (PROMO_CLASS_RE.test(attrs)) return "promo";
    if (BANNER_CLASS_RE.test(attrs)) return "banner";

    return FALLBACK_ROLE;
  }

  const role = decide();
  assertRole(role);
  return role;
}
