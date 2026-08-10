import { useEffect, useMemo, useState } from "react";
import { LABEL_DESCRIPTIONS, type Label } from "../../lib/taxonomy";
import {
  findingsStorageKey,
  stripFragment,
  type ContextReply,
  type ExplainReply,
  type StoredFindings,
  type ClassifyItemResult,
} from "../../lib/messaging";
import { scoreBand, type MergedFinding } from "../../lib/merge";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  updateSettings,
  type Settings,
} from "../../lib/settings";

/**
 * Findings grouped by category, page score, click-to-expand explanation, and
 * click-to-scroll-and-highlight. See docs/ARCHITECTURE.md 4.3.
 *
 * The settings block is duplicated from the popup on purpose, not by
 * oversight: when "open the side panel on icon click" is on (the default),
 * clicking the toolbar icon no longer opens the popup at all, so the popup's
 * copy of the controls becomes unreachable. Whichever surface the icon opens
 * has to be able to switch back.
 */
export function SidePanel() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [storedRaw, setStoredRaw] = useState<StoredFindings | null>(null);
  /** URL of the tab the panel is following, fragment stripped. Compared
   * against the findings' own documentUrl so the panel never shows one page's
   * findings while the user is looking at another -- the storage entry can
   * legitimately still hold the previous page's results for the moment
   * between navigating and the first batch of the new page landing. */
  const [tabUrl, setTabUrl] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  /** Which finding's explanation is expanded, as `${item.id}:${label}` -- a
   * single candidate can carry more than one label, and each is its own
   * explanation. */
  const [expanded, setExpanded] = useState<string | null>(null);

  // Track the active tab so the panel follows the user between tabs rather
  // than freezing on whichever tab was active when it first opened.
  useEffect(() => {
    let cancelled = false;

    async function loadActiveTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (cancelled) return;
      setTabId(tab?.id ?? null);
      setTabUrl(tab?.url ? stripFragment(tab.url) : null);
    }
    loadActiveTab();

    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
      setTabId(info.tabId);
      void chrome.tabs.get(info.tabId).then((tab) => {
        setTabUrl(tab?.url ? stripFragment(tab.url) : null);
      });
    };
    // Follow in-tab navigations too, not just tab switches: without this the
    // panel keeps the URL it started with and every subsequent page's
    // findings look like they belong to a different document.
    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => {
      if (!tab.active || !changeInfo.url) return;
      setTabId(updatedTabId);
      setTabUrl(stripFragment(changeInfo.url));
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  useEffect(() => {
    void loadSettings().then(setSettings);
    return onSettingsChanged(setSettings);
  }, []);

  useEffect(() => {
    if (tabId === null) return;
    const key = findingsStorageKey(tabId);
    let cancelled = false;

    async function load() {
      const result = await chrome.storage.session.get(key);
      if (!cancelled) setStoredRaw((result[key] as StoredFindings | undefined) ?? null);
    }
    load();

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "session" || !(key in changes)) return;
      setStoredRaw((changes[key]!.newValue as StoredFindings | undefined) ?? null);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [tabId]);

  /** Findings, but only if they belong to the page currently in the tab.
   * Mismatched entries are treated as absent rather than shown with a
   * caveat -- the user is looking at a different page, and stale findings
   * pointing at elements that no longer exist are actively misleading. */
  const stored = useMemo(() => {
    if (!storedRaw) return null;
    if (tabUrl !== null && storedRaw.documentUrl !== tabUrl) return null;
    return storedRaw;
  }, [storedRaw, tabUrl]);

  const grouped = useMemo(() => {
    const map = new Map<Label, ClassifyItemResult[]>();
    for (const item of stored?.items ?? []) {
      for (const finding of item.findings) {
        const label = finding.label as Label;
        const list = map.get(label) ?? [];
        list.push(item);
        map.set(label, list);
      }
    }
    return map;
  }, [stored]);

  function handleScrollTo(selector: string) {
    if (tabId === null) return;
    chrome.tabs.sendMessage(tabId, { type: "dp/scroll-to", selector });
  }

  async function handleSettingChange(patch: Partial<Settings>) {
    setSettings((prev) => ({ ...prev, ...patch }));
    await updateSettings(patch);
  }

  const band = stored ? scoreBand(stored.pageScore) : null;

  return (
    <div className="p-4 font-sans text-sm">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <h1 className="font-semibold">Findings</h1>
        <button
          type="button"
          className="text-xs underline text-gray-500 hover:text-gray-700"
          onClick={() => setShowSettings((prev) => !prev)}
        >
          {showSettings ? "Hide settings" : "Settings"}
        </button>
      </div>

      {showSettings && (
        <div className="border rounded p-2 mb-3 space-y-1 bg-gray-50">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.scanEnabled}
              onChange={(e) => handleSettingChange({ scanEnabled: e.target.checked })}
            />
            Scan pages
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={settings.overlayVisible}
              onChange={(e) => handleSettingChange({ overlayVisible: e.target.checked })}
            />
            Show badges on page
          </label>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings.openSidePanelOnIconClick}
              onChange={(e) =>
                handleSettingChange({ openSidePanelOnIconClick: e.target.checked })
              }
            />
            <span>Open this panel when I click the extension icon</span>
          </label>
          <p className="text-[11px] text-gray-400 pt-1">
            Chrome controls which side this panel appears on -- use the panel's
            own menu in Chrome to move it. An extension can't set that.
          </p>
        </div>
      )}

      {stored ? (
        <p className="text-xs text-gray-500 mb-4">
          Page score: <span className="font-medium">{stored.pageScore}/100</span>{" "}
          ({band}) -- {stored.items.length}{" "}
          {stored.items.length === 1 ? "snippet" : "snippets"} flagged
        </p>
      ) : (
        <p className="text-xs text-gray-500 mb-4">
          {settings.scanEnabled
            ? "No scan run yet. Findings will appear here grouped by category."
            : "Scanning is off. Turn it back on in Settings to analyse this page."}
        </p>
      )}

      {grouped.size === 0 && stored && (
        <p className="text-xs text-gray-500">Nothing flagged on this page.</p>
      )}

      <div className="space-y-4">
        {[...grouped.entries()].map(([label, items]) => (
          <div key={label}>
            <div className="font-medium capitalize">{label.replace(/_/g, " ")}</div>
            <div className="text-xs text-gray-500 mb-2">{LABEL_DESCRIPTIONS[label]}</div>
            <ul className="space-y-2">
              {items.map((item) => {
                const finding = item.findings.find((f) => (f.label as Label) === label)!;
                const key = `${item.id}:${label}`;
                return (
                  <li key={key} className="border rounded">
                    <button
                      type="button"
                      className="w-full text-left p-2 cursor-pointer hover:bg-gray-50"
                      aria-expanded={expanded === key}
                      onClick={() => setExpanded((prev) => (prev === key ? null : key))}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs uppercase tracking-wide text-gray-400">
                          {finding.confidence}
                        </span>
                        <span className="text-xs text-gray-400">{item.role}</span>
                      </div>
                      <div className="text-sm mt-1 line-clamp-2">{item.text}</div>
                    </button>

                    {expanded === key && (
                      <FindingDetail
                        item={item}
                        finding={finding}
                        tabId={tabId}
                        onScrollTo={() => handleScrollTo(item.selector)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The expanded "why was this flagged" view for one finding.
 *
 * Provenance is spelled out in words rather than left as the raw `source`
 * chips: "model" vs "rule" vs both is the single most load-bearing thing in
 * this UI -- it's the difference between a structural fact about the page and
 * a text-classifier's opinion -- and it was previously shown only as two
 * unexplained lowercase tags.
 */
function FindingDetail({
  item,
  finding,
  tabId,
  onScrollTo,
}: {
  item: ClassifyItemResult;
  finding: MergedFinding;
  tabId: number | null;
  onScrollTo: () => void;
}) {
  const hasRule = finding.source.includes("rule");
  const hasModel = finding.source.includes("model");
  const explain = useExplanation(item, finding, tabId);

  const provenance = hasRule && hasModel
    ? "Both a structural page rule and the text classifier agree on this."
    : hasRule
      ? "A structural rule matched something about how this element is built, independently of its wording."
      : "The text classifier flagged the wording. No structural rule corroborated it, so treat this as weaker evidence.";

  return (
    <div className="border-t p-2 space-y-2 bg-gray-50">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-400">Why</div>
        <p className="text-xs text-gray-700">{finding.description}</p>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-400">Evidence</div>
        <p className="text-xs text-gray-700">{provenance}</p>
        <div className="flex gap-1 mt-1">
          {finding.source.map((s) => (
            <span
              key={s}
              className="text-[10px] uppercase tracking-wide bg-gray-200 rounded px-1"
            >
              {s}
            </span>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-400">
          Matched text
        </div>
        <p className="text-xs text-gray-700 break-words">"{item.text}"</p>
      </div>

      <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-gray-500">
        <dt>Confidence</dt>
        <dd className="text-gray-700">{finding.confidence}</dd>
        <dt>Element</dt>
        <dd className="text-gray-700">
          &lt;{item.tag}&gt; as {item.role}
        </dd>
        {/* Score is only meaningful for model findings -- a rule hit is
            assigned a flat score of 1 by merge.ts, so showing it next to a
            threshold would imply a comparison that never happened. */}
        {hasModel && (
          <>
            <dt>Model score</dt>
            <dd className="text-gray-700">
              {finding.score.toFixed(2)} (threshold {finding.threshold.toFixed(2)})
            </dd>
          </>
        )}
      </dl>

      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-400">
          In more detail
        </div>

        {explain.status === "idle" && (
          <button
            type="button"
            className="w-full border rounded px-2 py-1 text-xs bg-white hover:bg-gray-100 mt-1"
            onClick={explain.run}
          >
            Explain this finding
          </button>
        )}

        {explain.status === "loading" && (
          <p className="text-xs text-gray-500 mt-1">
            Writing an explanation... a local model can take a while.
          </p>
        )}

        {explain.status === "done" && (
          <>
            <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap">
              {explain.explanation}
            </p>
            {/* Disclosure, not decoration: a different system wrote this text
                than flagged the element, and the reader is entitled to know
                which -- especially when the explanation is more fluent and
                confident-sounding than the classifier's own evidence. */}
            <p className="text-[10px] text-gray-400 mt-1">
              Written by {explain.model}. It explains the finding above; it did
              not make it, and cannot change it.
            </p>
          </>
        )}

        {explain.status === "error" && (
          <div className="mt-1">
            <p className="text-xs text-red-600">{explain.error}</p>
            {explain.retryable && (
              <button
                type="button"
                className="text-xs underline text-gray-500 hover:text-gray-700 mt-1"
                onClick={explain.run}
              >
                Try again
              </button>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        className="w-full border rounded px-2 py-1 text-xs bg-white hover:bg-gray-100"
        onClick={onScrollTo}
      >
        Show me on the page
      </button>
    </div>
  );
}

type ExplainState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; explanation: string; model: string }
  | { status: "error"; error: string; retryable: boolean };

/**
 * On-demand explanation for one finding.
 *
 * Fires only when the user asks, never on expand: a generation costs seconds
 * on a local model and a rate-limit slot on a hosted one, and most findings
 * are self-evident from the static description already shown above it.
 *
 * DOM context is gathered from the content script at request time rather than
 * cached with the finding, because the page may have re-rendered since the
 * scan and stale neighbours are worse than none.
 */
function useExplanation(
  item: ClassifyItemResult,
  finding: MergedFinding,
  tabId: number | null,
): ExplainState & { run: () => void } {
  const [state, setState] = useState<ExplainState>({ status: "idle" });

  // Reset when the hook is reused for a different finding -- without this, an
  // explanation for one item can flash in the detail view of the next.
  const identity = `${item.id}:${finding.label}`;
  const [lastIdentity, setLastIdentity] = useState(identity);
  if (identity !== lastIdentity) {
    setLastIdentity(identity);
    setState({ status: "idle" });
  }

  async function run() {
    setState({ status: "loading" });

    let context: Array<{ text: string; tag: string; role: string }> = [];
    if (tabId !== null) {
      try {
        const reply = (await chrome.tabs.sendMessage(tabId, {
          type: "dp/get-context",
          selector: item.selector,
        })) as ContextReply | undefined;
        context = reply?.context ?? [];
      } catch {
        // The page navigated away, or has no content script. An explanation
        // without neighbours is still useful, so this is not fatal.
        context = [];
      }
    }

    const reply = (await chrome.runtime.sendMessage({
      type: "dp/explain",
      request: {
        text: item.text,
        label: finding.label,
        tag: item.tag,
        role: item.role,
        lang: "en",
        confidence: finding.confidence,
        source: finding.source,
        score: finding.source.includes("model") ? finding.score : undefined,
        threshold: finding.source.includes("model") ? finding.threshold : undefined,
        rule_hits: [],
        context,
      },
    })) as ExplainReply | undefined;

    if (!reply) {
      setState({
        status: "error",
        error: "The extension's background worker did not respond.",
        retryable: true,
      });
      return;
    }
    if (!reply.ok) {
      setState({ status: "error", error: reply.error, retryable: reply.retryable });
      return;
    }
    setState({ status: "done", explanation: reply.explanation, model: reply.model });
  }

  return { ...state, run: () => void run() };
}
