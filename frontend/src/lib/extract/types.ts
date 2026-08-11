import type { Lang } from "../taxonomy";
import type { Role } from "../roles";
import type { Field } from "./fields";

export type { Role };
export type { Field };

export type Step = "product" | "cart" | "payment";

/** One extracted DOM candidate, matching the field table in
 * docs/ARCHITECTURE.md section 4.1. */
export interface Candidate {
  id: string; // sha1(lang + "\0" + text), set by hash.ts after extraction
  text: string; // innerText, trimmed, collapsed whitespace, capped at 200 chars
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
