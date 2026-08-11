import type { Candidate } from "./extract/types";
import type { RuleHit } from "./rules/types";
import type { MergedFinding, WithheldFinding } from "./merge";
import type { ExplainRequest } from "./api/explain";
import type { StoreTraceRequest } from "./api/traces";

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
  /** The document these candidates came from, fragment stripped. Supplied by
   * the content script from its own `location.href` rather than read from
   * `sender.tab.url`, because on a same-document SPA navigation the tab's URL
   * and the DOM the content script actually walked can disagree for a moment
   * -- and attributing one page's findings to another is the bug this field
   * exists to prevent. */
  pageUrl: string;
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
  /** Model findings a merge policy refused, with the reason (merge.ts's
   * withholdReason). Carried so the debug trace can show a suppressed finding
   * instead of leaving it indistinguishable from the model having said
   * nothing. An item may have these and no visible findings at all; readers
   * that render findings must skip those rather than count them. */
  withheld?: WithheldFinding[];
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
  /** Document these results describe. The content script drops a push whose
   * URL is not the page it is currently showing -- an in-flight batch from
   * the previous route can still land after an SPA navigation, and rendering
   * it puts the old page's badges on the new page. */
  documentUrl: string;
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

/** Sent content.ts -> background.ts to archive a settled page scan. Routed
 * through the background worker for the same reason classify and explain are:
 * one place holds the API base URL, and the content script never talks to the
 * backend directly. */
export interface UploadTraceMessage {
  type: "dp/upload-trace";
  request: StoreTraceRequest;
}

/** Sent side panel/popup -> content.ts to archive the current page's trace
 * right now. The content script owns the trace, so the trigger has to reach
 * it; it then hands the payload to the background worker, which is the only
 * place that talks to the backend.
 *
 * There is deliberately no automatic counterpart. A trace is real text from
 * the page in front of the user, so each capture is its own decision rather
 * than something a once-flipped setting keeps doing silently. */
export interface UploadTraceNowMessage {
  type: "dp/upload-trace-now";
}

export interface UploadTraceNowReply {
  ok: boolean;
  message: string;
}

export type UploadTraceReply =
  | { ok: true; objectKey: string; replaced: boolean }
  | { ok: false; error: string };

export type ExtensionMessage =
  | ClassifyCandidatesMessage
  | ClassifyProgressMessage
  | ScrollToMessage
  | ExportTraceMessage
  | ExplainMessage
  | GetContextMessage
  | UploadTraceMessage
  | UploadTraceNowMessage;

/** chrome.storage.session key holding the latest findings for a tab, so the
 * popup and side panel (which don't share a direct message channel with the
 * content script) can read current state without round-tripping through it.
 * MV3 service workers are killed aggressively -- this is why it's
 * chrome.storage.session and not a module-scope variable in background.ts. */
export function findingsStorageKey(tabId: number): string {
  return `findings:${tabId}`;
}

/** chrome.storage.session key holding the last *document* URL seen for a tab
 * (its fragment stripped). Compared on navigation to tell a real page change
 * from a same-document hash change, which Chrome reports identically -- see
 * the tabs.onUpdated listener in background.ts. */
export function lastDocumentUrlKey(tabId: number): string {
  return `docurl:${tabId}`;
}

/** A URL with any `#fragment` removed. Returns the input unchanged if it isn't
 * parseable -- callers compare the result for equality, and an unparseable URL
 * comparing equal to itself is the correct, conservative outcome. */
export function stripFragment(url: string): string {
  const hashIndex = url.indexOf("#");
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

export interface StoredFindings {
  pageScore: number;
  updatedAt: number;
  items: ClassifyItemResult[];
  /** Document these findings describe, fragment stripped.
   *
   * Findings used to be keyed by tab id alone, with a navigation listener
   * clearing them. That is a race: the clear is asynchronous, and a classify
   * response for the *previous* page can be written after it, resurrecting
   * findings for a page nobody is looking at. Stamping the URL makes every
   * reader able to tell for itself whether what it loaded belongs to the page
   * in front of it, instead of trusting that a cleanup ran in time. */
  documentUrl: string;
}

// The scan on/off toggle used to live here as SCAN_ENABLED_KEY, a single
// chrome.storage.session flag. It now lives in lib/settings.ts, split into
// separate scan/display settings and persisted in chrome.storage.local --
// see that module's header for why. A per-host allowlist remains the
// eventual design (frontend/README.md); the toggles are still global.
