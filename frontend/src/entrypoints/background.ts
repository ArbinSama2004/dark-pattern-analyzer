/**
 * Background service worker: batches candidates into groups of 32-64,
 * retries with exponential backoff, dedupes against a session cache,
 * enforces a per-page ceiling, and applies the rule/model merge policy.
 * See docs/ARCHITECTURE.md 4.2 and 4.5.
 *
 * MV3 service workers are killed aggressively -- session state lives in
 * chrome.storage.session, not module scope, so a killed-and-restarted
 * worker doesn't lose the dedupe cache mid-page.
 */
import { createClassifyClient, type SnippetResult } from "../lib/api/classify";
import { mergeFindings, computePageScore } from "../lib/merge";
import {
  findingsStorageKey,
  SCAN_ENABLED_KEY,
  type ClassifyCandidatesMessage,
  type ClassifyItemResult,
  type ExtensionMessage,
  type StoredFindings,
} from "../lib/messaging";

const BATCH_SIZE = 32;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 250;
const MAX_SNIPPETS_PER_PAGE = 600;

// TODO(stage3): make configurable per environment (dev vs packaged build) --
// e.g. via import.meta.env or a build-time define, rather than hardcoded.
const API_BASE_URL = "http://localhost:8000";

const client = createClassifyClient({ baseUrl: API_BASE_URL });

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt >= MAX_RETRIES) throw err;
      const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Session-scoped id -> result cache, persisted to chrome.storage.session
 * (survives a worker restart, cleared when the browser session ends) so a
 * MutationObserver re-run doesn't re-pay for an id already resolved. */
const CACHE_STORAGE_KEY = "dp/classify-cache";

async function loadCache(): Promise<Record<string, SnippetResult>> {
  const stored = await chrome.storage.session.get(CACHE_STORAGE_KEY);
  return (stored[CACHE_STORAGE_KEY] as Record<string, SnippetResult>) ?? {};
}

async function saveCache(cache: Record<string, SnippetResult>): Promise<void> {
  await chrome.storage.session.set({ [CACHE_STORAGE_KEY]: cache });
}

async function isScanEnabled(): Promise<boolean> {
  const stored = await chrome.storage.session.get(SCAN_ENABLED_KEY);
  // Default on -- absent means "never toggled", not "turned off".
  return stored[SCAN_ENABLED_KEY] !== false;
}

async function handleClassifyCandidates(
  message: ClassifyCandidatesMessage,
  tabId: number | undefined,
): Promise<{ items: ClassifyItemResult[]; pageScore: number }> {
  if (tabId === undefined) return { items: [], pageScore: 0 };
  if (!(await isScanEnabled())) return { items: [], pageScore: 0 };

  // Captured as its own const so TS keeps the number-not-undefined narrowing
  // inside the persistProgress closure below (narrowing of the outer `tabId`
  // parameter doesn't survive across a nested function boundary).
  const knownTabId: number = tabId;

  const capped = message.candidates.slice(0, MAX_SNIPPETS_PER_PAGE);
  const cache = await loadCache();

  const uncached = capped.filter(({ candidate }) => !(candidate.id in cache));
  const batches = chunk(uncached, BATCH_SIZE);

  // Merges whatever is in `cache` right now into stored findings and writes
  // it to chrome.storage.session. Called after every batch (not just once at
  // the end) for two reasons:
  //  1. The side panel listens on chrome.storage.onChanged, so results
  //     appear live as batches complete instead of after the whole page --
  //     which matters a lot on fp32 CPU inference (see docs/PROGRESS.md
  //     "Latency is not claimed"): a large page can take many seconds across
  //     many batches.
  //  2. If the service worker is killed or the message channel times out
  //     before the final sendResponse (exactly the failure mode behind
  //     "message channel closed before a response was received"), findings
  //     already written to storage are not lost -- only the content
  //     script's overlay update for this pass is.
  function persistProgress(): { items: ClassifyItemResult[]; pageScore: number } {
    const items: ClassifyItemResult[] = capped.map(({ candidate, ruleHits }) => {
      const modelResult = cache[candidate.id];
      return {
        id: candidate.id,
        text: candidate.text,
        role: candidate.role,
        selector: candidate.selector,
        findings: mergeFindings(ruleHits, modelResult),
      };
    });
    const withFindings = items.filter((i) => i.findings.length > 0);
    const pageScore = computePageScore(withFindings.map((i) => i.findings));
    const stored: StoredFindings = {
      pageScore,
      updatedAt: Date.now(),
      items: withFindings,
    };
    // Fire-and-forget: batches must not wait on this write to keep going.
    void chrome.storage.session.set({ [findingsStorageKey(knownTabId)]: stored });
    return { items: withFindings, pageScore };
  }

  let latest = persistProgress(); // rule-only findings visible immediately, before any batch returns

  for (const batch of batches) {
    if (batch.length === 0) continue;
    try {
      const response = await withRetry(() =>
        client.classify({
          snippets: batch.map(({ candidate }) => ({
            text: candidate.text,
            tag: candidate.tag,
            role: candidate.role,
            lang: candidate.lang,
            ref: candidate.id,
          })),
        }),
      );
      for (const result of response.results) {
        if (result.ref) cache[result.ref] = result;
      }
    } catch (err) {
      // A batch failing after retries shouldn't take down the whole page's
      // results -- the rule-only findings for this batch still get merged
      // below, just without model evidence.
      console.error("[dark-pattern-analyzer] classify batch failed", err);
    }
    latest = persistProgress();
  }

  await saveCache(cache);

  return latest;
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener(
    (message: ExtensionMessage, sender, sendResponse) => {
      if (message.type !== "dp/classify-candidates") return undefined;

      handleClassifyCandidates(message, sender.tab?.id)
        .then(({ items, pageScore }) =>
          sendResponse({ type: "dp/classify-result", results: items, pageScore }),
        )
        .catch((err) => {
          console.error("[dark-pattern-analyzer] handleClassifyCandidates failed", err);
          sendResponse({ type: "dp/classify-result", results: [], pageScore: 0 });
        });

      return true; // keep the message channel open for the async response
    },
  );

  // Clear the per-tab findings and dedupe cache when a tab navigates away,
  // so stale findings from the previous page never leak into the new one.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
      chrome.storage.session.remove(findingsStorageKey(tabId));
    }
  });

  console.log("Dark Pattern Analyzer background worker started");
});