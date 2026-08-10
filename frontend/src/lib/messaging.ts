import type { Candidate } from "./extract/types";
import type { RuleHit } from "./rules/types";
import type { MergedFinding } from "./merge";
import type { ExplainRequest } from "./api/explain";

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

/** Sent side panel -> content.ts to collect the extracted candidates that sit
 * near a finding in the DOM, for use as LLM explanation context. The content
 * script is the only surface that knows the page's live element registry --
 * the panel has findings, not the full extraction, and neighbouring text is
 * usually *not* itself a finding (a price next to a countdown). */
export interface GetContextMessage {
  type: "dp/get-context";
  selector: string;
}

export interface ContextReply {
  context: Array<{ text: string; tag: string; role: string }>;
}

/** Sent side panel -> background.ts to request a plain-language explanation
 * of one finding from POST /v1/explain. Routed through the background worker
 * for the same reason classify is: the API base URL stays in one place.
 *
 * On demand, one finding at a time -- never batched at scan time. A page with
 * 600 candidates already takes tens of seconds to classify; generating
 * explanations nobody asked to read would multiply that for no benefit. */
export interface ExplainMessage {
  type: "dp/explain";
  request: ExplainRequest;
}

/** Response to ExplainMessage. A discriminated result rather than a rejected
 * promise, because chrome.runtime.sendMessage flattens thrown errors into an
 * opaque lastError string and the UI needs the distinction between "provider
 * is down, offer retry" and "this won't work, don't". */
export type ExplainReply =
  | { ok: true; explanation: string; model: string; cached: boolean }
  | { ok: false; error: string; retryable: boolean };

export type ExtensionMessage =
  | ClassifyCandidatesMessage
  | ClassifyProgressMessage
  | ScrollToMessage
  | ExportTraceMessage
  | ExplainMessage
  | GetContextMessage;

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
