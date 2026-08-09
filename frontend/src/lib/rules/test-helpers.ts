import type { Candidate } from "../extract/types";
import type { Role } from "../roles";

export function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "test",
    text: "",
    tag: "span",
    role: "body" as Role,
    lang: "en",
    visible: true,
    font_px: 14,
    contrast: 5,
    checked: null,
    is_animated: false,
    step: "product",
    selector: "span",
    ...overrides,
  };
}
