import { useEffect, useState } from "react";
import { SCAN_ENABLED_KEY, findingsStorageKey, type StoredFindings } from "../../lib/messaging";
import { scoreBand } from "../../lib/merge";

/**
 * On/off toggle + current-page summary. See frontend/README.md's planned
 * layout. A per-host allowlist is the eventual design; this stage ships a
 * single global toggle instead (see messaging.ts's SCAN_ENABLED_KEY comment
 * for why that's a deliberate scope cut, not a silent gap).
 */
export function Popup() {
  const [enabled, setEnabled] = useState(true);
  const [host, setHost] = useState<string | null>(null);
  const [findings, setFindings] = useState<StoredFindings | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const stored = await chrome.storage.session.get(SCAN_ENABLED_KEY);
      const isEnabled = stored[SCAN_ENABLED_KEY] !== false; // default on

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let currentHost: string | null = null;
      let currentFindings: StoredFindings | null = null;
      if (tab?.url) {
        try {
          currentHost = new URL(tab.url).host;
        } catch {
          currentHost = null;
        }
      }
      if (tab?.id !== undefined) {
        const key = findingsStorageKey(tab.id);
        const result = await chrome.storage.session.get(key);
        currentFindings = (result[key] as StoredFindings | undefined) ?? null;
      }

      if (!cancelled) {
        setEnabled(isEnabled);
        setHost(currentHost);
        setFindings(currentFindings);
        setLoaded(true);
      }
    }

    load();

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== "session") return;
      if (SCAN_ENABLED_KEY in changes) {
        setEnabled(changes[SCAN_ENABLED_KEY]!.newValue !== false);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  async function handleToggle(next: boolean) {
    setEnabled(next);
    await chrome.storage.session.set({ [SCAN_ENABLED_KEY]: next });
  }

  const count = findings?.items.length ?? 0;
  const band = findings ? scoreBand(findings.pageScore) : null;

  return (
    <div className="p-4 font-sans text-sm w-64">
      <h1 className="font-semibold mb-2">Dark Pattern Analyzer</h1>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!loaded}
          onChange={(e) => handleToggle(e.target.checked)}
        />
        Scan this page
      </label>

      {host && <p className="text-xs text-gray-500 mt-1">{host}</p>}

      {loaded && enabled && (
        <div className="mt-3 border-t pt-3">
          {findings ? (
            <>
              <p className="text-sm">
                <span className="font-medium">{count}</span>{" "}
                {count === 1 ? "finding" : "findings"} on this page
              </p>
              {band && (
                <p className="text-xs text-gray-500 mt-1">
                  Page score: {findings.pageScore}/100 ({band})
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-gray-500">No findings yet -- still scanning.</p>
          )}
        </div>
      )}

      <p className="text-xs text-gray-400 mt-3">
        Flags potentially manipulative patterns. Scanning is user-initiated, per
        page. Open the side panel for details.
      </p>
    </div>
  );
}
