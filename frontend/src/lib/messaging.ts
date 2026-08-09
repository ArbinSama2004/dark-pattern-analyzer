import type { Candidate } from "./extract/types";
import type { RuleHit } from "./rules/types";
import type { MergedFinding } from "./merge";

/** One extracted candidate plus whatever the local rule engine already
 * found for it -- sent content.ts -> background.ts so the merge policy
 * (merge.ts) can combine rule and model evidence per docs/ARCHITECTURE.md
 * 4.5. */
export interface CandidateWithHits {
  candidate: Candidate;
  ruleHits: RuleHit[];
}

export interface ClassifyCandidatesMessage {
  type: "dp/classify-candidates";
  candidates: CandidateWithHits[];
}

export interface ClassifyItemResult {
  id: string;
  text: string;
  role: string;
  selector: string;
  findings: MergedFinding[];
}

export interface ClassifyResultMessage {
  type: "dp/classify-result";
  results: ClassifyItemResult[];
  pageScore: number;
}

/** Sent sidepanel/popup -> content.ts to scroll to and briefly highlight the
 * DOM node behind a finding. */
export interface ScrollToMessage {
  type: "dp/scroll-to";
  selector: string;
}

export type ExtensionMessage =
  | ClassifyCandidatesMessage
  | ScrollToMessage;

/** chrome.storage.session key holding the latest findings for a tab, so the
 * popup and side panel (which don't share a direct message channel with the
 * content script) can read current state without round-tripping through it.
 * MV3 service workers are killed aggressively -- this is why it's
 * chrome.storage.session and not a module-scope variable in background.ts. */
export function findingsStorageKey(tabId: number): string {
  return `findings:${tabId}`;
}

export interface StoredFindings {
  pageScore: number;
  updatedAt: number;
  items: ClassifyItemResult[];
}

/** chrome.storage.session key for the global scan on/off toggle the popup
 * controls. A per-host allowlist is the eventual design (frontend/README.md
 * mentions it), but a single global toggle is enough for this stage and
 * documented here as the intentional scope cut rather than a silent gap. */
export const SCAN_ENABLED_KEY = "dp/scan-enabled";
