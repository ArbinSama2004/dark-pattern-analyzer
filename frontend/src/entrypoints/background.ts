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
import { createExplainClient, ExplainApiError } from "../lib/api/explain";
import { createTraceClient, TraceApiError } from "../lib/api/traces";
import { mergeFindings, computePageScore } from "../lib/merge";
import { modelCacheKey } from "../lib/hash";
import type { CandidateWithHits } from "../lib/messaging";
import {
  findingsStorageKey,
  lastDocumentUrlKey,
  stripFragment,
  type ClassifyCandidatesMessage,
  type ClassifyItemResult,
  type ExtensionMessage,
  type StoredFindings,
} from "../lib/messaging";
import { loadSettings, onSettingsChanged, type Settings } from "../lib/settings";

const BATCH_SIZE = 32;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 250;
const MAX_SNIPPETS_PER_PAGE = 600;

// TODO(stage3): make configurable per environment (dev vs packaged build) --
// e.g. via import.meta.env or a build-time define, rather than hardcoded.
const API_BASE_URL = "http://localhost:8000";

const client = createClassifyClient({ baseUrl: API_BASE_URL });
const explainClient = createExplainClient({ baseUrl: API_BASE_URL });
const traceClient = createTraceClient({ baseUrl: API_BASE_URL });

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

/** Session-scoped model-cache-key -> result cache, persisted to
 * chrome.storage.session (survives a worker restart, cleared when the
 * browser session ends) so a MutationObserver re-run doesn't re-pay for a
 * model input already resolved.
 *
 * Keyed by `modelCacheKey` (lang+tag+role+text), NOT by candidate.id. As of
 * Fix 1, candidate.id is an *occurrence* id (unique per DOM node -- see
 * hash.ts) and must never be used as a cache key: keying this cache by
 * occurrence id would mean three identical "Add to Cart" buttons each pay
 * for their own forward pass and never share a result, defeating the whole
 * point of caching. Different occurrences with the same effective model
 * input are still allowed -- and expected -- to share one entry here. */
const CACHE_STORAGE_KEY = "dp/classify-cache";

/** Resolves every candidate's model-cache key up front so the rest of
 * handleClassifyCandidates can do plain synchronous Map/object lookups
 * instead of threading `await` through filters and loops. */
async function buildModelKeys(
  candidates: CandidateWithHits[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    candidates.map(async ({ candidate }) => {
      const key = await modelCacheKey(
        candidate.lang,
        candidate.text,
        candidate.tag,
        candidate.role,
      );
      return [candidate.id, key] as const;
    }),
  );
  return new Map(entries);
}

async function loadCache(): Promise<Record<string, SnippetResult>> {
  const stored = await chrome.storage.session.get(CACHE_STORAGE_KEY);
  return (stored[CACHE_STORAGE_KEY] as Record<string, SnippetResult>) ?? {};
}

async function saveCache(cache: Record<string, SnippetResult>): Promise<void> {
  await chrome.storage.session.set({ [CACHE_STORAGE_KEY]: cache });
}

/** Findings already accumulated for this tab *on this document*.
 *
 * Read back out of storage rather than kept in module scope because MV3 kills
 * the worker between messages -- a module-level Map would silently reset and
 * take every previously-found badge with it.
 *
 * The documentUrl check is what stops one page's findings leaking onto the
 * next. On an SPA (Daraz, most storefronts) an in-page navigation does not
 * reload the content script or reliably beat the navigation cleanup, so the
 * accumulator used to seed itself from the previous route's findings and
 * re-persist them -- which is why home-page patterns kept appearing on
 * product pages. A mismatch here means "different page, start empty", which
 * is correct regardless of whether any cleanup listener ran. */
async function loadStoredItems(
  tabId: number,
  documentUrl: string,
): Promise<ClassifyItemResult[]> {
  const key = findingsStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const findings = stored[key] as StoredFindings | undefined;
  if (!findings) return [];
  if (findings.documentUrl !== documentUrl) return [];
  return findings.items ?? [];
}

async function isScanEnabled(): Promise<boolean> {
  return (await loadSettings()).scanEnabled;
}

/**
 * Routes a toolbar-icon click to either the popup or the side panel,
 * per the user's preference.
 *
 * Chrome decides this at click time from two independent pieces of state:
 * whether the action has a popup registered, and whether
 * `openPanelOnActionClick` is set. A registered popup always wins, so
 * switching to the side panel means actively clearing the popup with
 * `setPopup({ popup: "" })` -- setting the panel behaviour alone has no
 * visible effect while a popup is still registered, which is the obvious
 * thing to try and the reason this needs both calls.
 *
 * Note on placement: Chrome renders the side panel on whichever side the
 * *user* has chosen in the browser's own UI (right by default; movable via
 * the side panel's own context menu). There is no extension API to force it
 * to the left -- that is a browser-level preference, not something this
 * manifest or any call here can set.
 */
async function applyIconBehavior(settings: Settings): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: settings.openSidePanelOnIconClick,
    });
    await chrome.action.setPopup({
      popup: settings.openSidePanelOnIconClick ? "" : "popup.html",
    });
  } catch (err) {
    // Older Chrome builds without the sidePanel API, or a transient failure
    // during worker startup. The popup remains reachable either way, so this
    // degrades to the previous behaviour rather than breaking the icon.
    console.warn("[dark-pattern-analyzer] could not apply icon behavior", err);
  }
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

  // The document these candidates describe. Every write below is stamped with
  // it, and every read is validated against it.
  const documentUrl = stripFragment(message.pageUrl);

  const capped = message.candidates.slice(0, MAX_SNIPPETS_PER_PAGE);
  const cache = await loadCache();
  // occurrenceId (candidate.id) -> modelCacheKey, one lookup built per
  // message so the model/cache identity is computed exactly once per
  // candidate rather than recomputed at every access below.
  const modelKeys = await buildModelKeys(capped);

  // Every finding known for this page so far, keyed by candidate id, seeded
  // from storage and then updated with this message's candidates.
  //
  // This is the fix for the overlay flickering on live pages. A message from
  // content.ts carries only the candidates that are *new since the last pass*
  // -- on a page with a countdown timer that is a single candidate, once per
  // tick. persistProgress() used to build its result set from `capped` alone,
  // so each of those one-candidate passes broadcast a one-item (often
  // zero-item) result set, and content.ts's overlay.update() replaces rather
  // than merges. The visible effect was every badge on the page being torn
  // down and rebuilt once or twice a second, and a page score that oscillated
  // between the real total and the score of whatever single snippet had just
  // been re-sent.
  const accumulated = new Map<string, ClassifyItemResult>();
  for (const item of await loadStoredItems(knownTabId, documentUrl)) {
    accumulated.set(item.id, item);
  }

  const uncached = capped.filter(({ candidate }) => {
    const key = modelKeys.get(candidate.id);
    return key !== undefined && !(key in cache);
  });
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
    for (const { candidate, ruleHits } of capped) {
      const modelKey = modelKeys.get(candidate.id);
      const findings = mergeFindings(ruleHits, modelKey ? cache[modelKey] : undefined);
      if (findings.length === 0) {
        // Benign after merging. Drop it rather than leaving a stale entry --
        // a snippet can only move to benign if a batch has now resolved it.
        accumulated.delete(candidate.id);
        continue;
      }
      accumulated.set(candidate.id, {
        id: candidate.id,
        text: candidate.text,
        tag: candidate.tag,
        role: candidate.role,
        selector: candidate.selector,
        findings,
      });
    }

    // Bound the accumulator the same way `capped` bounds one message. Map
    // iterates in insertion order, so this evicts the oldest findings first.
    while (accumulated.size > MAX_SNIPPETS_PER_PAGE) {
      const oldest = accumulated.keys().next();
      if (oldest.done) break;
      accumulated.delete(oldest.value);
    }

    const withFindings = [...accumulated.values()];
    const pageScore = computePageScore(withFindings.map((i) => i.findings));
    const stored: StoredFindings = {
      pageScore,
      updatedAt: Date.now(),
      items: withFindings,
      documentUrl,
    };
    // Fire-and-forget: batches must not wait on this write to keep going.
    void chrome.storage.session.set({ [findingsStorageKey(knownTabId)]: stored });

    // This push is the actual fix for "overlay freezes on large pages" --
    // the storage write above feeds the popup/side panel (they listen on
    // chrome.storage.onChanged), but the on-page overlay only listens for
    // this message (see content.ts's dp/classify-progress handler and
    // messaging.ts's ClassifyProgressMessage doc comment). Without this
    // call the overlay never updates on any page with more than one batch,
    // regardless of what the original sendMessage/sendResponse channel
    // does. Wrapped in a catch: if the tab navigated away or has no content
    // script (e.g. a chrome:// page), sendMessage rejects and that's fine
    // -- there's nothing to update.
    chrome.tabs
      .sendMessage(knownTabId, {
        type: "dp/classify-progress",
        results: withFindings,
        pageScore,
        documentUrl,
      })
      // Log real errors so they appear in the service-worker console
      // (chrome://extensions → "service worker" link). The previous
      // .catch(() => {}) was hiding failures that look like delivery
      // succeeding. Navigated-away tabs produce a benign
      // "Could not establish connection" error that is safe to ignore,
      // but any other error (e.g. missing host permission, wrong tabId)
      // should be visible during debugging.
      .catch((err: unknown) =>
        console.warn("[dark-pattern-analyzer] sendMessage(dp/classify-progress) failed:", err),
      );

    return { items: withFindings, pageScore };
  }

  console.log(
    `[dark-pattern-analyzer] tab ${knownTabId}: ${capped.length} candidates ` +
      `(${uncached.length} uncached) -> ${batches.length} batch(es)`,
  );

  let latest = persistProgress(); // rule-only findings visible immediately, before any batch returns

  for (const [i, batch] of batches.entries()) {
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
      console.log(
        `[dark-pattern-analyzer] batch ${i + 1}/${batches.length}: ` +
          `${response.results.length} results, ${response.meta.inference_ms}ms inference`,
      );
      // `result.ref` is the occurrence id we sent as `ref` (see the
      // classify() call below) -- echoed back per snippet, one result per
      // occurrence sent, even when several occurrences shared one forward
      // pass server-side (classify.py's own pending_index dedup). Store the
      // result under that occurrence's *model key*, not under `ref` itself,
      // so every other occurrence with the same effective model input --
      // including ones not sent in this batch at all -- can find it too.
      for (const result of response.results) {
        if (!result.ref) continue;
        const key = modelKeys.get(result.ref);
        if (key) cache[key] = result;
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
    (message: ExtensionMessage | { type: "dp/get-tab-id" }, sender, sendResponse) => {
      // Content scripts cannot call chrome.tabs.getCurrent() -- they have
      // no direct API to know their own tabId. We answer with the sender's
      // tabId so content.ts can subscribe to the right storage key
      // (findings:<tabId>) via chrome.storage.onChanged.
      if (message.type === "dp/get-tab-id") {
        sendResponse({ tabId: sender.tab?.id ?? null });
        return false;
      }

      if (message.type === "dp/upload-trace") {
        // No gate here: this message only exists as the result of a user
        // pressing "Save scan to archive", so the click *is* the
        // authorisation. A second check against a stored flag would be
        // checking something the user did not set.
        void (async () => {
          try {
            const response = await traceClient.store(message.request);
            console.log(
              `[dark-pattern-analyzer] archived trace -> ${response.object_key}` +
                (response.replaced ? " (replaced earlier capture)" : ""),
            );
            sendResponse({
              ok: true,
              objectKey: response.object_key,
              replaced: response.replaced,
            });
          } catch (err: unknown) {
            const message_ =
              err instanceof TraceApiError
                ? err.message
                : `Could not reach the backend at ${API_BASE_URL}.`;
            console.warn("[dark-pattern-analyzer] trace upload failed:", message_);
            sendResponse({ ok: false, error: message_ });
          }
        })();
        return true;
      }

      if (message.type === "dp/explain") {
        // Errors become a discriminated reply rather than a rejection:
        // sendMessage collapses a thrown error into an opaque lastError
        // string, which would lose the retryable/not distinction the panel
        // needs to decide whether to offer a retry.
        explainClient
          .explain(message.request)
          .then((response) =>
            sendResponse({
              ok: true,
              explanation: response.explanation,
              model: response.model,
              cached: response.cached,
            }),
          )
          .catch((err: unknown) => {
            const isApiError = err instanceof ExplainApiError;
            if (!isApiError) {
              console.error("[dark-pattern-analyzer] explain request failed", err);
            }
            sendResponse({
              ok: false,
              error: isApiError
                ? err.message
                : "Could not reach the backend. Is it running on " +
                  `${API_BASE_URL}?`,
              // A transport-level failure (backend not running) is as
              // retryable as a provider-level one.
              retryable: isApiError ? err.retryable : true,
            });
          });
        return true; // async response
      }

      if (message.type !== "dp/classify-candidates") return undefined;

      handleClassifyCandidates(message as ExtensionMessage & { type: "dp/classify-candidates" }, sender.tab?.id)
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

  // Clear the per-tab findings when a tab navigates to a *different document*,
  // so stale findings from the previous page never leak into the new one.
  //
  // This used to fire on any `changeInfo.status === "loading"`, which Chrome
  // also reports for same-document navigations -- including a bare hash
  // change. Daraz's home page rewrites the hash as you scroll through its
  // sections (#hp-flash-sale -> #hp-just-for-you -> ...), so scrolling wiped
  // every finding and the side panel dropped back to "No scan run yet"
  // mid-session. The document never changed; only the fragment did.
  //
  // Comparing the URL with its fragment stripped is what distinguishes the two.
  // A same-document hash change keeps its findings (the DOM they point at is
  // still there); a real navigation, including a reload to a different path or
  // a query change, clears them.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return;

    const documentUrl = stripFragment(changeInfo.url);
    void (async () => {
      const key = lastDocumentUrlKey(tabId);
      const stored = await chrome.storage.session.get(key);
      const previous = stored[key] as string | undefined;

      if (previous === documentUrl) return; // fragment-only change

      await chrome.storage.session.set({ [key]: documentUrl });
      await chrome.storage.session.remove(findingsStorageKey(tabId));
    })();
  });

  // Drop the per-tab bookkeeping when the tab itself goes away, so a recycled
  // tab id can never inherit the previous tab's document URL and skip a clear.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void chrome.storage.session.remove([
      findingsStorageKey(tabId),
      lastDocumentUrlKey(tabId),
    ]);
  });

  // Applied on every worker start, not just on install: MV3 kills this
  // worker aggressively and panel behaviour does not survive that, so a
  // once-only chrome.runtime.onInstalled hook would leave the icon reverting
  // to the popup after the first idle timeout.
  void loadSettings().then(applyIconBehavior);
  onSettingsChanged((settings) => void applyIconBehavior(settings));

  console.log("Dark Pattern Analyzer background worker started");
});