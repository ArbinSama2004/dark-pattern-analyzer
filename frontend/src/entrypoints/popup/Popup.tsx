import { useEffect, useState } from "react";
import {
  findingsStorageKey,
  stripFragment,
  type StoredFindings,
  type UploadTraceNowReply,
} from "../../lib/messaging";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  updateSettings,
  type Settings,
} from "../../lib/settings";
import { scoreBand } from "../../lib/merge";
import { ThemeToggle } from "../../ui/ThemeToggle";

/**
 * Controls + current-page summary. See frontend/README.md's planned layout.
 * A per-host allowlist is the eventual design; the toggles here are still
 * global (see lib/settings.ts for what each one actually gates).
 */
export function Popup() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [host, setHost] = useState<string | null>(null);
  const [findings, setFindings] = useState<StoredFindings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tabId, setTabId] = useState<number | null>(null);
  /** Resolved up front so handleOpenSidePanel can stay synchronous -- see
   * the comment there for why that matters. */
  const [windowId, setWindowId] = useState<number | null>(null);
  const [exportStatus, setExportStatus] = useState<"idle" | "sent" | "error">("idle");
  const [archiveStatus, setArchiveStatus] = useState<"idle" | "saving" | "done" | "error">(
    "idle",
  );
  const [archiveMessage, setArchiveMessage] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const current = await loadSettings();

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
        const found = (result[key] as StoredFindings | undefined) ?? null;
        // Only show findings that belong to the page this tab is actually on.
        // Between navigating and the new page's first batch landing, the
        // storage entry still holds the previous page's results.
        const currentUrl = tab.url ? stripFragment(tab.url) : null;
        currentFindings =
          found && (currentUrl === null || found.documentUrl === currentUrl) ? found : null;
      }

      if (!cancelled) {
        setSettings(current);
        setHost(currentHost);
        setFindings(currentFindings);
        setTabId(tab?.id ?? null);
        setWindowId(tab?.windowId ?? null);
        setLoaded(true);
      }
    }

    load();

    const unsubscribe = onSettingsChanged(setSettings);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  async function handleSettingChange(patch: Partial<Settings>) {
    // Optimistic: the storage write round-trips through onSettingsChanged and
    // would otherwise leave the checkbox visibly lagging the click.
    setSettings((prev) => ({ ...prev, ...patch }));
    await updateSettings(patch);
  }

  function handleOpenSidePanel() {
    if (windowId === null) return;
    // chrome.sidePanel.open() must be called during a user gesture, and an
    // `await` before it ends that gesture -- so the windowId it needs is
    // resolved ahead of time in the load effect rather than looked up here.
    // Deliberately not awaited: this handler has to stay synchronous.
    void chrome.sidePanel.open({ windowId });
  }

  /** Archives this page's extracted JSON to MinIO. Only ever runs from this
   * click -- there is no automatic path, by design (see settings.ts). */
  async function handleArchiveScan() {
    if (tabId === null) return;
    setArchiveStatus("saving");
    setArchiveMessage("");
    try {
      const reply = (await chrome.tabs.sendMessage(tabId, {
        type: "dp/upload-trace-now",
      })) as UploadTraceNowReply | undefined;
      setArchiveStatus(reply?.ok ? "done" : "error");
      setArchiveMessage(reply?.message ?? "No response from the page.");
    } catch {
      setArchiveStatus("error");
      setArchiveMessage("Couldn't reach this tab. Reload the page and try again.");
    }
  }

  /**
   * A button, not a console command. window.__dpExportTrace() (content.ts)
   * only runs when DevTools' Console context dropdown happens to be pointed
   * at the content script's isolated world -- easy to miss, and it silently
   * looks like the feature doesn't exist ("is not a function") rather than
   * "wrong context". chrome.tabs.sendMessage doesn't have that problem: it
   * reaches the content script's listener regardless of which world any
   * DevTools panel is looking at.
   */
  async function handleExportTrace() {
    if (tabId === null) {
      setExportStatus("error");
      return;
    }
    try {
      await chrome.tabs.sendMessage(tabId, { type: "dp/export-trace" });
      setExportStatus("sent");
    } catch {
      // No content script on this tab (e.g. a chrome:// page) or it hasn't
      // finished loading yet.
      setExportStatus("error");
    }
  }

  const count = findings?.items.length ?? 0;
  const band = findings ? scoreBand(findings.pageScore) : null;

  return (
    <div className="p-4 font-sans text-sm w-64">
      <h1 className="font-semibold mb-2">Dark Pattern Analyzer</h1>

      <div className="space-y-1">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.scanEnabled}
            disabled={!loaded}
            onChange={(e) => handleSettingChange({ scanEnabled: e.target.checked })}
          />
          Scan pages
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.overlayVisible}
            disabled={!loaded}
            onChange={(e) => handleSettingChange({ overlayVisible: e.target.checked })}
          />
          Show badges on page
        </label>
      </div>

      {host && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{host}</p>}

      {loaded && settings.scanEnabled && (
        <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
          {findings ? (
            <>
              <p className="text-sm">
                <span className="font-medium">{count}</span>{" "}
                {count === 1 ? "finding" : "findings"} on this page
              </p>
              {band && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Page score: {findings.pageScore}/100 ({band})
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">No findings yet -- still scanning.</p>
          )}
        </div>
      )}

      <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3 space-y-2">
        <button
          type="button"
          className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
          onClick={handleOpenSidePanel}
          disabled={windowId === null}
        >
          Open side panel
        </button>
        <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={settings.openSidePanelOnIconClick}
            disabled={!loaded}
            onChange={(e) =>
              handleSettingChange({ openSidePanelOnIconClick: e.target.checked })
            }
          />
          <span>
            Open the side panel when I click the extension icon (instead of this
            popup).
          </span>
        </label>
        <p className="text-[11px] text-gray-400 dark:text-gray-500">
          Chrome controls which side the panel appears on. To move it left, use
          the panel's own menu in Chrome -- an extension can't set this.
        </p>

        <div>
          <div className="text-xs mb-1">Appearance</div>
          <ThemeToggle
            value={settings.theme}
            disabled={!loaded}
            onChange={(theme) => handleSettingChange({ theme })}
          />
        </div>
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500 mt-3">
        Flags potentially manipulative patterns. Scanning is user-initiated, per
        page. Open the side panel for details.
      </p>

      <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
        <button
          type="button"
          className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-xs bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 mb-2"
          onClick={handleArchiveScan}
          disabled={archiveStatus === "saving" || tabId === null}
        >
          {archiveStatus === "saving" ? "Saving..." : "Save this scan to the archive"}
        </button>
        {archiveMessage && (
          <p
            className={`text-[11px] mb-2 ${
              archiveStatus === "error"
                ? "text-red-600 dark:text-red-400"
                : "text-green-700 dark:text-green-400"
            }`}
          >
            {archiveMessage}
          </p>
        )}

        <button
          type="button"
          className="text-xs underline text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          onClick={handleExportTrace}
        >
          Download debug trace (JSON)
        </button>
        {exportStatus === "sent" && (
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Check your downloads -- the file saves from the page tab, not this popup.
          </p>
        )}
        {exportStatus === "error" && (
          <p className="text-xs text-red-500 dark:text-red-400 mt-1">
            Couldn't reach this tab's content script. Reload the page and try again.
          </p>
        )}
      </div>
    </div>
  );
}
