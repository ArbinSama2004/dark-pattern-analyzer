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

// "call us"/"कल गर्न" added after a real trace: a Jeevee footer line offering a
// support number ("you can call us for any help") was typed role=body, and the
// model read it as the cancel-by-phone obstruction pattern. Typing it as what it
// is lets merge.ts apply the support-line policy -- which still reports an
// obstruction when the wording is actually about cancelling.
const SUPPORT_KEYWORDS: Record<string, string[]> = {
  en: ["contact support", "contact us", "help center", "help section", "customer service", "call us"],
  hi: ["सहायता केंद्र", "हमसे संपर्क करें", "हमें कॉल"],
  ne: ["सहायता केन्द्र", "हामीलाई सम्पर्क गर्नुहोस्", "हामीलाई कल", "हामीलाई फोन"],
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

/**
 * Matches text that is unmistakably a discount badge regardless of class
 * name, e.g. "-8%", "15% off", "Save NPR 300", "₹200 off".
 *
 * `-\d+%` is matched as its own token (bounded by start/whitespace on
 * either side), not anchored to the whole string. A real trace from a live
 * page (dark-pattern-analyzer-trace-*.json) caught the anchored version
 * missing "Rs. 2,499 -54%" -- the exact same discount as an isolated "-54%"
 * node elsewhere on the page, which DID match and got flagged. Whether a
 * site's markup joins the price and the discount into one text node or
 * keeps them in separate elements is a template detail with no bearing on
 * whether the discount itself is worth the same role -- and, in turn, the
 * same downstream model signal.
 */
const DISCOUNT_TEXT_RE = /(?:^|\s)-\d+%(?:\s|$)|\b\d+%\s*off\b|\bsave\s+[\d,]+|\bsave\s+\d+%/i;

/**
 * Fix 4, Part A: signals for structural UI controls that are clickable
 * buttons but not an accept-side "do the thing" call to action -- carousel
 * arrows, pagination, filter/sort toggles, expand/collapse, close buttons,
 * quantity steppers, menu/dropdown openers. The previous rule was "any
 * <button> or role=button that matched neither wordlist is cta", which
 * swept all of these into "cta" too.
 *
 * Matched against the accessible name (aria-label/title -- the more
 * deliberate signal an icon-only control usually carries) and class/id
 * tokens. Deliberately does NOT match on bare visible text alone for most
 * categories: "next"/"menu" etc. are common enough words in genuine CTA
 * copy (a checkout wizard's own "Next" button, a restaurant's "Menu" link)
 * that matching them without a structural or accessible-name anchor would
 * risk demoting real CTAs instead of narrowing false ones. Close is the one
 * exception, since "close"/"×"/"✕" as an entire button's content is not
 * plausible CTA wording.
 */
const CAROUSEL_CONTROL_RE =
  /\b(carousel|slider|slide|gallery)\b.*\b(next|prev(ious)?)\b|\b(next|prev(ious)?)\b.*\b(carousel|slider|slide|gallery)\b/i;
const PAGINATION_RE = /\bpagination\b|\b(next|prev(ious)?)[\s-]*page\b|\bpage[\s-]*(next|prev(ious)?)\b/i;
const FILTER_SORT_RE = /\b(filter|sort)\b/i;
const EXPAND_COLLAPSE_RE = /\b(expand|collapse|accordion)\b/i;
const CLOSE_CONTROL_RE = /^(close|dismiss|×|✕|✖)$/i;
const QUANTITY_RE = /\b(qty|quantity)\b|\b(increase|decrease|increment|decrement)\b/i;
const MENU_DROPDOWN_RE = /\b(dropdown|menu)\b/i;

/**
 * True for a button-like element whose accessible name or class/id marks it
 * as one of the generic UI-control categories above, rather than an
 * accept-side call to action. `aria-expanded`/`aria-haspopup` are checked
 * directly (not by wording) because they are the standard, deliberate ARIA
 * markers for a toggle/popup-opener regardless of what text or class the
 * site happens to use.
 */
function isGenericUiControl(el: Element, text: string, accessibleName: string, attrs: string): boolean {
  if (el.hasAttribute("aria-expanded") || el.hasAttribute("aria-haspopup")) return true;

  const name = accessibleName.toLowerCase();
  if (CAROUSEL_CONTROL_RE.test(name) || CAROUSEL_CONTROL_RE.test(attrs)) return true;
  if (PAGINATION_RE.test(name) || PAGINATION_RE.test(attrs)) return true;
  if (FILTER_SORT_RE.test(name) || FILTER_SORT_RE.test(attrs)) return true;
  if (EXPAND_COLLAPSE_RE.test(name) || EXPAND_COLLAPSE_RE.test(attrs)) return true;
  if (CLOSE_CONTROL_RE.test(text.trim())) return true;
  if (QUANTITY_RE.test(name) || QUANTITY_RE.test(attrs)) return true;
  if (MENU_DROPDOWN_RE.test(attrs)) return true; // class/id only -- see doc comment above.

  return false;
}

/**
 * Class/id tokens for common video-player implementations (video.js, Plyr,
 * YouTube's own player chrome, and generic "video-player"/"media-player"
 * naming). Matched against a bounded ancestor walk, not just the element
 * itself -- a duration/remaining-time label usually isn't the `<video>`
 * element's own descendant, it's a sibling control inside a shared player
 * container.
 */
const VIDEO_PLAYER_RE = /\b(video-?player|media-?player|vjs-|plyr|ytp-)\b/i;
const VIDEO_PLAYER_SCAN_DEPTH = 6;

/**
 * True if `el` sits inside a video player's UI chrome -- a duration label
 * ("0:35") or a remaining-time readout ("Remaining Time - 0:00") shares the
 * exact same `MM:SS` shape as a genuine countdown-to-deadline timer, and
 * nothing about the text alone distinguishes "this clip is 35 seconds long"
 * from "checkout closes in 35 seconds." A real trace caught this: every
 * `false_urgency` hit on one product page (12 of them) was a video
 * duration/progress label with zero rule corroboration, all pattern-matched
 * purely because role=timer told the model "treat this MM:SS as urgency."
 */
export function isVideoPlayerContext(el: Element): boolean {
  let node: Element | null = el;
  for (let depth = 0; node && depth < VIDEO_PLAYER_SCAN_DEPTH; depth += 1, node = node.parentElement) {
    if (node.tagName.toLowerCase() === "video") return true;
    if (typeof node.querySelector === "function" && node.querySelector("video")) return true;
    const cls = typeof node.className === "string" ? node.className : "";
    if (VIDEO_PLAYER_RE.test(`${cls} ${node.id ?? ""}`)) return true;
  }
  return false;
}

function normalizedText(el: Element): string {
  return (el.textContent ?? "").trim().toLowerCase();
}

function classAndId(el: Element): string {
  const cls = typeof el.className === "string" ? el.className : "";
  return `${cls} ${el.id ?? ""}`;
}

/**
 * Keyword match on whole words, not substrings.
 *
 * `text.includes("cancel")` matches inside "Cancelling" and "Cancellation".
 * Measured on a real Amazon headphones page: **28 elements were assigned
 * `role=decline`, and 28 of 28 were noise-*cancelling* product titles.* A
 * title typed as a decline control then fires `cancel_offsite` and
 * `cta_asymmetry`, and tells the model the string is a decline button --
 * 12 of that page's 50 findings came from this one missing boundary.
 *
 * `\b` in JavaScript is defined against `[A-Za-z0-9_]`, so a Devanagari
 * keyword has no word boundaries anywhere and a bounded pattern would never
 * match. Hindi and Nepali keywords therefore keep substring semantics --
 * which is also the correct behaviour for a script that does not delimit
 * words the way the boundary assertion assumes.
 */
const LATIN_KEYWORD_RE = /^[\x20-\x7E]+$/;
const keywordPatterns = new Map<string, RegExp | null>();

function keywordPattern(keyword: string): RegExp | null {
  if (!keywordPatterns.has(keyword)) {
    keywordPatterns.set(
      keyword,
      LATIN_KEYWORD_RE.test(keyword)
        ? new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
        : null,
    );
  }
  return keywordPatterns.get(keyword) ?? null;
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some((kw) => {
    const pattern = keywordPattern(kw);
    return pattern ? pattern.test(text) : text.includes(kw.toLowerCase());
  });
}

function closest(el: Element, selector: string): Element | null {
  return typeof el.closest === "function" ? el.closest(selector) : null;
}

/**
 * `candidateText`, when given, is used instead of recomputing text from
 * `el.textContent` -- it should be extract.ts's already-computed
 * `candidateText` for this element. This matters specifically for the
 * leaf-block-coalescing case (extract.ts's `leafBlockText`): when a parent
 * element's candidate text is built by joining several inline children,
 * `leafBlockText` inserts an explicit space between them, but raw
 * `el.textContent` reflects whatever whitespace actually exists in the DOM
 * -- which can be none, if a site relies on CSS margin/gap for visual
 * spacing between adjacent inline elements rather than an actual space
 * character. A real trace caught this: "Rs. 1,500" and "-33%" in adjacent
 * `<span>`s with no separating text node produced candidate text "Rs. 1,500
 * -33%" (extract.ts's join) but `el.textContent` "Rs. 1,500-33%" (no
 * space) -- the digit run right before "-33%" then meant the discount
 * pattern never matched, and the exact same discount elsewhere on the page
 * (as its own isolated node) got flagged while this one silently didn't.
 * Falls back to recomputing from the element for callers (tests, or any
 * future caller) that don't have extract.ts's candidate text on hand.
 *
 * `isAnimated` is whether this element's text has been observed changing on a
 * regular cadence (lib/timer-tracker.ts). It gates the timer branch -- see the
 * comment there. Defaults to false, so a caller that cannot supply it gets the
 * conservative answer rather than a timer inferred from text shape alone.
 */
export function inferRole(
  el: Element,
  lang: string,
  candidateText?: string,
  isAnimated = false,
): Role {
  const accessibleName =
    el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "";
  const text = (candidateText?.toLowerCase() ?? normalizedText(el)) || accessibleName.toLowerCase();
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
    // An explicit type="submit" *attribute* is unambiguous evidence of a
    // primary form action regardless of wording -- checked before the
    // generic-control exclusions below so a submit button can never be swept
    // into "body" by an unlucky aria-label/class collision. Deliberately
    // reads the attribute, not the `.type` IDL property: per the HTML spec a
    // bare <button> with no type attribute at all still reports `.type ===
    // "submit"` (the missing-value default), which would otherwise make
    // this branch fire for every plain button and silently skip every
    // exclusion below it.
    if (tag === "button" && el.getAttribute("type")?.toLowerCase() === "submit") {
      return "cta";
    }
    if (
      (tag === "button" || el.getAttribute("role") === "button") &&
      !isGenericUiControl(el, text, accessibleName, attrs)
    ) {
      // A button matching neither wordlist, not a submit control, and not
      // recognisable as a carousel/pagination/filter/expand/close/quantity/
      // menu control -- still worth flagging structurally as a generic
      // accept-side control, since most remaining unclassified buttons on
      // e-commerce pages are. Fix 4, Part A: this used to fire for *every*
      // button regardless of kind; recognised generic UI controls now fall
      // through to the generic-content checks below instead.
      return "cta";
    }

    if (
      FINE_PRINT_CLASS_RE.test(attrs) ||
      (el instanceof HTMLElement && parseFloat(getComputedStyle(el).fontSize) < 11)
    ) {
      return "fine_print";
    }
    // A countdown ticks; a video's duration label does not. `MM:SS` alone is
    // not evidence of a deadline -- the shape is identical, and the
    // video-player exclusion below it can only recognise players whose class
    // names it happens to list. A real Amazon page's video carousel matched
    // none of them, and all 10 of its clip lengths ("0:40", "13:42") became
    // role=timer, which then told the model to read them as urgency: 10 of
    // that page's 50 findings.
    //
    // Observed cadence is the signal that actually separates the two, it is
    // already measured live (lib/timer-tracker.ts), and `countdown_timer`
    // already requires it -- the role now agrees with the rule instead of
    // trusting the text shape. A genuine countdown is typed on the tick after
    // it is first seen rather than immediately, which costs one second on a
    // page that then has the finding for as long as the tab is open.
    if (
      (TIMER_CLASS_RE.test(attrs) ||
        (isAnimated && /\b\d{1,2}:\d{2}(:\d{2})?\b/.test(text))) &&
      !isVideoPlayerContext(el)
    ) {
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
