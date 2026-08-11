import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, initTheme, prefersDark, resolveTheme } from "./theme";
import { updateSettings } from "./settings";

/** chrome.storage.local double, same shape as the one in settings.test.ts --
 * initTheme reads settings and subscribes to changes, so it needs both. */
function installChromeStorageDouble() {
  const store: Record<string, unknown> = {};
  const listeners: Array<
    (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void
  > = [];

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            const oldValue = store[key];
            store[key] = value;
            for (const listener of listeners)
              listener({ [key]: { oldValue, newValue: value } }, "local");
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
}

/** jsdom has no matchMedia. Installs one that reports the given OS
 * preference and can fire a change, which is the only way to test the
 * "system" branch reacting to the desktop switching. */
function installMatchMedia(dark: boolean) {
  const handlers: Array<() => void> = [];
  const mql = {
    matches: dark,
    addEventListener: vi.fn((_: string, fn: () => void) => handlers.push(fn)),
    removeEventListener: vi.fn((_: string, fn: () => void) => {
      const index = handlers.indexOf(fn);
      if (index >= 0) handlers.splice(index, 1);
    }),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => mql));
  return {
    mql,
    set(next: boolean) {
      mql.matches = next;
      for (const fn of [...handlers]) fn();
    },
  };
}

beforeEach(() => {
  installChromeStorageDouble();
  vi.unstubAllGlobals();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
});

describe("resolveTheme", () => {
  it("follows the OS only for 'system'", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("ignores the OS for an explicit choice", () => {
    // The whole point of the override: a user on a dark desktop who picks
    // light must get light.
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("toggles the class Tailwind's darkMode reads", () => {
    const root = document.createElement("html");

    applyTheme(root, "dark");
    expect(root.classList.contains("dark")).toBe(true);

    applyTheme(root, "light");
    expect(root.classList.contains("dark")).toBe(false);
  });

  it("sets color-scheme too, for the controls Tailwind can't reach", () => {
    const root = document.createElement("html");

    applyTheme(root, "dark");
    expect(root.style.colorScheme).toBe("dark");
  });
});

describe("prefersDark", () => {
  it("degrades to light where matchMedia does not exist", () => {
    // Not hypothetical for this codebase: the same absence is why
    // test-setup.ts polyfills CSS.escape. Throwing here would take the whole
    // panel down before it rendered.
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersDark()).toBe(false);
  });
});

describe("initTheme", () => {
  it("applies the OS preference synchronously, before storage is read", () => {
    installMatchMedia(true);
    const root = document.createElement("html");

    initTheme(root);

    // Not awaited on purpose -- this is the anti-flash guarantee.
    expect(root.classList.contains("dark")).toBe(true);
  });

  it("corrects to the stored override once storage resolves", async () => {
    installMatchMedia(true);
    await updateSettings({ theme: "light" });
    const root = document.createElement("html");

    initTheme(root);
    await vi.waitFor(() => expect(root.classList.contains("dark")).toBe(false));
  });

  it("reacts to a change made in another surface", async () => {
    installMatchMedia(false);
    const root = document.createElement("html");
    initTheme(root);

    await updateSettings({ theme: "dark" });

    await vi.waitFor(() => expect(root.classList.contains("dark")).toBe(true));
  });

  it("follows the OS switching while set to 'system'", async () => {
    const media = installMatchMedia(false);
    const root = document.createElement("html");
    initTheme(root);
    await vi.waitFor(() => expect(root.style.colorScheme).toBe("light"));

    media.set(true);

    expect(root.classList.contains("dark")).toBe(true);
  });

  it("ignores the OS switching once an override is set", async () => {
    // OS dark + stored override light, so the wait below observes a real
    // transition: it proves the stored preference has landed, rather than
    // passing on the synchronous guess and testing nothing.
    const media = installMatchMedia(true);
    await updateSettings({ theme: "light" });
    const root = document.createElement("html");
    initTheme(root);
    await vi.waitFor(() => expect(root.classList.contains("dark")).toBe(false));

    media.set(false);
    media.set(true);

    expect(root.classList.contains("dark")).toBe(false);
  });

  it("stops listening after teardown", async () => {
    const media = installMatchMedia(true);
    await updateSettings({ theme: "light" });
    const root = document.createElement("html");
    const stop = initTheme(root);
    await vi.waitFor(() => expect(root.classList.contains("dark")).toBe(false));

    stop();
    media.set(true);
    await updateSettings({ theme: "dark" });

    expect(root.classList.contains("dark")).toBe(false);
  });
});
