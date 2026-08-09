import type { Rule } from "./types";

const SUBSCRIBE_KEYWORDS = [
  "email",
  "sms",
  "newsletter",
  "text message",
  "marketing",
  "offers",
  "ईमेल",
  "समाचार",
  "इमेल",
];

/** The checkbox's own text is usually empty (candidate.text is the direct
 * text of the checkbox element itself, per extract.ts) -- the meaningful
 * copy lives in an associated <label>. Check, in order: the input's
 * `.labels` collection, an ancestor <label>, and aria-label/aria-labelledby. */
function associatedLabelText(el: Element): string {
  if (el instanceof HTMLInputElement && el.labels && el.labels.length > 0) {
    return Array.from(el.labels)
      .map((l) => l.textContent ?? "")
      .join(" ");
  }
  const ancestorLabel = el.closest("label");
  if (ancestorLabel) return ancestorLabel.textContent ?? "";

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const referenced = document.getElementById(labelledBy);
    if (referenced) return referenced.textContent ?? "";
  }

  return "";
}

/**
 * A checkbox that starts checked, whose label mentions a subscription-style
 * consent (email, SMS, marketing). See docs/ARCHITECTURE.md 4.5.
 */
export const precheckedOptin: Rule = (candidate, el) => {
  if (candidate.role !== "checkbox" || candidate.checked !== true) return [];

  const label = associatedLabelText(el).toLowerCase();
  const matches = SUBSCRIBE_KEYWORDS.some((kw) => label.includes(kw));
  if (!matches) return [];

  return [{ rule: "prechecked_optin", label: "sneaking" }];
};
