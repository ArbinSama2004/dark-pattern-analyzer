import type { Lang } from "../taxonomy";
import type { Role } from "../roles";
import type { Field } from "./fields";

export type { Role };
export type { Field };

export type Step = "product" | "cart" | "payment";

/** One extracted DOM candidate, matching the field table in
 * docs/ARCHITECTURE.md section 4.1. */
export interface Candidate {
  /** occurrenceId: sha1(lang + NUL + selector + NUL + text) -- see hash.ts.
   * Identity of one DOM node, not of a string: the selector is folded in so
   * three separate "Add to Cart" buttons stay three candidates. */
  id: string;
  /** The element's own text nodes joined, or -- when it has none and all its
   * children are inline -- its inline children's text joined. Whitespace
   * collapsed, trimmed, bounded by MIN/MAX_TEXT_LENGTH. Deliberately not
   * `innerText`, which would pull in every descendant's text and duplicate it
   * onto every ancestor. */
  text: string;
  tag: string; // tagName.toLowerCase()
  role: Role;
  /** Which part of a product listing this text is (title, price, discount,
   * ...), inferred from structural evidence rather than CSS class names --
   * see fields.ts. Local to the extension: rules gate on it, and it appears
   * in the debug trace. It is deliberately NOT sent to the backend, whose
   * model input format is frozen (invariant #2). */
  field: Field;
  lang: Lang;
  visible: boolean;
  font_px: number | null;
  contrast: number | null;
  checked: boolean | null;
  is_animated: boolean; // set later by the timer-cadence observer, defaults false
  step: Step | null;
  selector: string; // stable CSS path, for overlay highlight
}

/** Elements never worth walking into or extracting text from. */
export const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "head",
  "template",
]);

export const MIN_TEXT_LENGTH = 3;
export const MAX_TEXT_LENGTH = 200;
