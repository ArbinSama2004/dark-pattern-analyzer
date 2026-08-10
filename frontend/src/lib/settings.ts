/**
 * User-facing extension settings, shared by the popup, side panel, content
 * script and background worker.
 *
 * Two deliberate departures from the previous SCAN_ENABLED_KEY approach in
 * messaging.ts:
 *
 * 1. **chrome.storage.local, not .session.** A preference the user set is not
 *    session state -- storing it in `session` meant every toggle silently
 *    reverted to the default when the browser restarted, which reads as the
 *    setting not working rather than as an intentional scope.
 *
 * 2. **Scanning and display are separate settings.** They were one flag, but
 *    they are not one decision: turning scanning off stopped new
 *    classification while leaving every badge already on the page in place,
 *    so "hide the dark patterns" had no control at all. Hiding is also
 *    instant and free, whereas re-enabling scanning costs a full re-scan --
 *    conflating them made the cheap operation pay the expensive one's price.
 *
 * Stored as a single object under one key so a read is one round trip and a
 * change notification carries the whole coherent state, rather than three
 * keys that can be observed mid-update in an inconsistent combination.
 */

export interface Settings {
  /** Extract and classify new candidates. Off leaves existing findings alone. */
  scanEnabled: boolean;
  /** Draw badges on the page. Independent of scanning -- findings keep
   * accumulating in the side panel while the on-page overlay is hidden. */
  overlayVisible: boolean;
  /** Clicking the toolbar icon opens the side panel instead of the popup. */
  openSidePanelOnIconClick: boolean;
}

// There is deliberately no "upload traces" setting here. Archiving a scan
// sends real text from the page in front of the user, and that is a decision
// worth making per capture rather than once, in a settings panel, and then
// forgetting. It is a button in the side panel and the popup instead -- see
// UploadTraceNowMessage in messaging.ts.

export const DEFAULT_SETTINGS: Settings = {
  scanEnabled: true,
  overlayVisible: true,
  openSidePanelOnIconClick: true,
};

export const SETTINGS_KEY = "dp/settings";

/** Normalises whatever is in storage into a complete Settings object.
 * Field-by-field rather than a spread of the stored value, so a key written
 * by an older build (or a partially-written object) can't inject an
 * undefined into a boolean field -- the same class of runtime type violation
 * that crashed the overlay when a stored `tag` turned out to be missing. */
export function normalizeSettings(raw: unknown): Settings {
  const stored = (raw ?? {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    scanEnabled:
      typeof stored.scanEnabled === "boolean"
        ? stored.scanEnabled
        : DEFAULT_SETTINGS.scanEnabled,
    overlayVisible:
      typeof stored.overlayVisible === "boolean"
        ? stored.overlayVisible
        : DEFAULT_SETTINGS.overlayVisible,
    openSidePanelOnIconClick:
      typeof stored.openSidePanelOnIconClick === "boolean"
        ? stored.openSidePanelOnIconClick
        : DEFAULT_SETTINGS.openSidePanelOnIconClick,
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

/** Applies a partial update on top of current settings and persists the
 * result. Returns the full settings object as written, so callers don't have
 * to re-read to know the resulting state. */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Subscribes to settings changes. Returns an unsubscribe function.
 *
 * Every surface that shows a toggle needs this: with the popup, side panel
 * and page overlay all able to read the same settings, a change made in one
 * has to reach the others without a reload.
 */
export function onSettingsChanged(callback: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== "local" || !(SETTINGS_KEY in changes)) return;
    callback(normalizeSettings(changes[SETTINGS_KEY]?.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
