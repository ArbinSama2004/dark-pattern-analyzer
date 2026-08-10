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
  /** The candidate's HTML tag, lowercased -- e.g. "button", "span". Added for
   * Fix 2: resolve.ts's DOM resolver needs it to verify a re-resolved
   * element is structurally the right kind of node, not just one with
   * matching text. */
  tag: string;
  role: string;
  selector: string;
  findings: MergedFinding[];
}

export interface ClassifyResultMessage {
  type: "dp/classify-result";
  results: ClassifyItemResult[];
  pageScore: number;
}

/** Pushed background.ts -> content.ts after every batch completes, in
 * addition to the eventual sendResponse to the original message. Lets the
 * on-page overlay update live instead of freezing until the whole page's
 * batches finish (which can take 15-30s+ on fp32 CPU inference -- see
 * docs/PROGRESS.md "Latency is not claimed"). */
export interface ClassifyProgressMessage {
  type: "dp/classify-progress";
  results: ClassifyItemResult[];
  pageScore: number;
}

/** Sent sidepanel/popup -> content.ts to scroll to and briefly highlight the
 * DOM node behind a finding. */
export interface ScrollToMessage {
  type: "dp/scroll-to";
  selector: string;
}

/** Sent popup -> content.ts to trigger a download of the full extraction ->
 * classification trace (see content.ts's `exportTrace`). A popup button, not
 * a console command: window.__dpExportTrace() only works when DevTools'
 * Console context is pointed at the content script's isolated world, which
 * is easy to get wrong -- this message-based trigger works regardless. */
export interface ExportTraceMessage {
  type: "dp/export-trace";
}

export type ExtensionMessage =
  | ClassifyCandidatesMessage
  | ClassifyProgressMessage
  | ScrollToMessage
  | ExportTraceMessage;

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

// The scan on/off toggle used to live here as SCAN_ENABLED_KEY, a single
// chrome.storage.session flag. It now lives in lib/settings.ts, split into
// separate scan/display settings and persisted in chrome.storage.local --
// see that module's header for why. A per-host allowlist remains the
// eventual design (frontend/README.md); the toggles are still global.
