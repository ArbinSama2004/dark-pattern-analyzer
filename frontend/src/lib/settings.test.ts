import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  normalizeSettings,
  onSettingsChanged,
  updateSettings,
} from "./settings";

/** Minimal in-memory chrome.storage.local + onChanged double. Enough to
 * exercise the read/write/subscribe contract without pulling in a full
 * extension-API mock library. */
function installChromeStorageDouble() {
  const store: Record<string, unknown> = {};
  const listeners: Array<
    (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void
  > = [];

  const chromeDouble = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            const oldValue = store[key];
            store[key] = value;
            for (const listener of listeners) listener({ [key]: { oldValue, newValue: value } }, "local");
          }
        }),
      },
      onChanged: {
        addListener: vi.fn((fn: (typeof listeners)[number]) => listeners.push(fn)),
        removeListener: vi.fn((fn: (typeof listeners)[number]) => {
          const index = listeners.indexOf(fn);
          if (index >= 0) listeners.splice(index, 1);
        }),
      },
    },
  };

  (globalThis as unknown as { chrome: unknown }).chrome = chromeDouble;
  return { store, listeners };
}

beforeEach(() => {
  installChromeStorageDouble();
});

describe("normalizeSettings", () => {
  it("returns defaults for missing storage", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("fills in only the fields that are absent", () => {
    expect(normalizeSettings({ overlayVisible: false })).toEqual({
      ...DEFAULT_SETTINGS,
      overlayVisible: false,
    });
  });

  it("rejects non-boolean values written by an older or broken build", () => {
    // The overlay crash this codebase already hit came from trusting a
    // stored field's declared type at runtime. Booleans get the same
    // treatment: a stale string is replaced by the default, not passed
    // through to be used in a conditional.
    expect(normalizeSettings({ scanEnabled: "yes", overlayVisible: null })).toEqual(
      DEFAULT_SETTINGS,
    );
  });
});

describe("loadSettings / updateSettings", () => {
  it("defaults to everything on before anything is written", async () => {
    await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a partial update without clobbering other fields", async () => {
    await updateSettings({ overlayVisible: false });
    await expect(loadSettings()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      overlayVisible: false,
    });

    await updateSettings({ scanEnabled: false });
    await expect(loadSettings()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      overlayVisible: false,
      scanEnabled: false,
    });
  });

  it("returns the full resulting settings, not just the patch", async () => {
    await expect(updateSettings({ scanEnabled: false })).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      scanEnabled: false,
    });
  });

  it("carries no setting that could archive page text on its own", async () => {
    // Archiving is a button, not a preference -- there must be no persisted
    // flag that keeps uploading page content after being flipped once. This
    // asserts the absence, so reintroducing such a setting has to be a
    // deliberate change to this test rather than a quiet addition.
    const settings = await loadSettings();

    expect(Object.keys(settings).sort()).toEqual([
      "openSidePanelOnIconClick",
      "overlayVisible",
      "scanEnabled",
    ]);
  });

  it("keeps scanning and overlay visibility independent", async () => {
    // The whole reason these are two settings: turning the overlay off must
    // not stop scanning, and vice versa.
    await updateSettings({ overlayVisible: false });
    const settings = await loadSettings();

    expect(settings.overlayVisible).toBe(false);
    expect(settings.scanEnabled).toBe(true);
  });
});

describe("onSettingsChanged", () => {
  it("notifies subscribers with the complete new settings", async () => {
    const seen: unknown[] = [];
    onSettingsChanged((settings) => seen.push(settings));

    await updateSettings({ overlayVisible: false });

    expect(seen).toEqual([{ ...DEFAULT_SETTINGS, overlayVisible: false }]);
  });

  it("stops notifying after unsubscribe", async () => {
    const seen: unknown[] = [];
    const unsubscribe = onSettingsChanged((settings) => seen.push(settings));
    unsubscribe();

    await updateSettings({ overlayVisible: false });

    expect(seen).toEqual([]);
  });

  it("ignores changes to other keys and other storage areas", async () => {
    const seen: unknown[] = [];
    onSettingsChanged((settings) => seen.push(settings));

    await chrome.storage.local.set({ "some/other/key": 1 });

    expect(seen).toEqual([]);
    expect(SETTINGS_KEY).toBe("dp/settings");
  });
});
