import type { Rule } from "./types";

const MIN_READABLE_FONT_PX = 11;
const MIN_READABLE_CONTRAST = 3.0;
const MIN_READABLE_OPACITY = 0.6;

/**
 * A decline control (role "decline") made hard to see: tiny font, low
 * contrast, or low opacity. See docs/ARCHITECTURE.md 4.5.
 *
 * Opacity isn't one of extract.ts's captured Candidate fields (only the
 * boolean `visible`, which already excludes opacity: 0 entirely -- an
 * element flagged here is visible but faint, not hidden). This rule reads
 * computed opacity directly off the live element instead.
 */
export const hiddenOptout: Rule = (candidate, el) => {
  if (candidate.role !== "decline") return [];

  const fontTooSmall =
    candidate.font_px !== null && candidate.font_px < MIN_READABLE_FONT_PX;
  const contrastTooLow =
    candidate.contrast !== null && candidate.contrast < MIN_READABLE_CONTRAST;

  let opacityTooLow = false;
  if (el instanceof HTMLElement) {
    const opacity = parseFloat(getComputedStyle(el).opacity);
    opacityTooLow = !Number.isNaN(opacity) && opacity < MIN_READABLE_OPACITY;
  }

  if (!fontTooSmall && !contrastTooLow && !opacityTooLow) return [];

  return [
    { rule: "hidden_optout", label: "sneaking" },
    { rule: "hidden_optout", label: "obstruction" },
  ];
};
