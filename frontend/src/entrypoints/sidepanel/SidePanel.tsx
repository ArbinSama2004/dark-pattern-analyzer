import { useEffect, useMemo, useState } from "react";
import { LABEL_DESCRIPTIONS, type Label } from "../../lib/taxonomy";
import { findingsStorageKey, type StoredFindings, type ClassifyItemResult } from "../../lib/messaging";
import { scoreBand } from "../../lib/merge";

/**
 * Findings grouped by category, page score, click-to-scroll-and-highlight.
 * See docs/ARCHITECTURE.md 4.3.
 */
export function SidePanel() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [stored, setStored] = useState<StoredFindings | null>(null);

  // Track the active tab so the panel follows the user between tabs rather
  // than freezing on whichever tab was active when it first opened.
  useEffect(() => {
    let cancelled = false;

    async function loadActiveTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!cancelled) setTabId(tab?.id ?? null);
    }
    loadActiveTab();

    const onActivated = (info: chrome.tabs.TabActiveInfo) => setTabId(info.tabId);
    chrome.tabs.onActivated.addListener(onActivated);
    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
    };
  }, []);

  useEffect(() => {
    if (tabId === null) return;
    const key = findingsStorageKey(tabId);
    let cancelled = false;

    async function load() {
      const result = await chrome.storage.session.get(key);
      if (!cancelled) setStored((result[key] as StoredFindings | undefined) ?? null);
    }
    load();

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "session" || !(key in changes)) return;
      setStored((changes[key]!.newValue as StoredFindings | undefined) ?? null);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [tabId]);

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

  function handleClick(selector: string) {
    if (tabId === null) return;
    chrome.tabs.sendMessage(tabId, { type: "dp/scroll-to", selector });
  }

  const band = stored ? scoreBand(stored.pageScore) : null;

  return (
    <div className="p-4 font-sans text-sm">
      <h1 className="font-semibold mb-1">Findings</h1>

      {stored ? (
        <p className="text-xs text-gray-500 mb-4">
          Page score: <span className="font-medium">{stored.pageScore}/100</span>{" "}
          ({band}) -- {stored.items.length}{" "}
          {stored.items.length === 1 ? "snippet" : "snippets"} flagged
        </p>
      ) : (
        <p className="text-xs text-gray-500 mb-4">
          No scan run yet. Findings will appear here grouped by category.
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
                return (
                  <li
                    key={item.id}
                    className="border rounded p-2 cursor-pointer hover:bg-gray-50"
                    onClick={() => handleClick(item.selector)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs uppercase tracking-wide text-gray-400">
                        {finding.confidence}
                      </span>
                      <span className="text-xs text-gray-400">{item.role}</span>
                    </div>
                    <div className="text-sm mt-1 line-clamp-2">{item.text}</div>
                    <div className="text-xs text-gray-500 mt-1">{finding.description}</div>
                    <div className="flex gap-1 mt-1">
                      {finding.source.map((s) => (
                        <span
                          key={s}
                          className="text-[10px] uppercase tracking-wide bg-gray-100 rounded px-1"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
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
