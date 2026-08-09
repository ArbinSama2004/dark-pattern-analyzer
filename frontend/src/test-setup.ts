// jsdom does not implement CSS.escape (it's a real browser API, not part of
// the DOM spec jsdom targets). selector.ts uses it to build stable CSS
// selectors for the overlay. Polyfilled here for tests only -- the actual
// Chrome extension runtime has the real implementation.
if (typeof CSS === "undefined" || typeof CSS.escape !== "function") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).CSS = {
    ...(globalThis as any).CSS,
    escape(value: string): string {
      return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
    },
  };
}
