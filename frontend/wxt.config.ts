import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Dark Pattern Analyzer",
    description:
      "Flags potentially manipulative UI patterns on e-commerce pages you're viewing. Not a legal compliance tool.",
    // "scripting" was unused -- nothing in this codebase calls
    // chrome.scripting; the content script is declared statically via
    // WXT's entrypoints convention instead. Dropped to keep the install
    // prompt minimal.
    permissions: ["storage", "sidePanel", "activeTab", "tabs"],
    // Host permissions must cover every origin where the extension runs,
    // not just localhost. chrome.tabs.sendMessage (MV3 service worker →
    // content script) is silently dropped by Chrome if the destination
    // tab's origin isn't listed here -- this was why __dpRenderDebug was
    // always undefined on daraz.com.np even though the code path was
    // correct. "http://localhost/*" was sufficient while the backend-only
    // smoke tests ran, but the extension needs to deliver messages to real
    // e-commerce pages, so we need the broad match here.
    // See: https://developer.chrome.com/docs/extensions/develop/concepts/
    //      match-patterns#special
    host_permissions: ["http://localhost/*", "*://*/*"],
    action: {
      default_title: "Dark Pattern Analyzer",
    },
    side_panel: {
      default_path: "sidepanel.html",
    },
  },
  srcDir: "src",
  runner: {
    // Was https://example.com -- a placeholder that opens a page with none
    // of the dark patterns this extension looks for. Point this at whatever
    // fixture or real page you're actively testing against; the saved
    // fixtures in backend/tests/fixtures/pages/ (Stage 4) are a good default
    // once they exist.
    startUrls: ["http://localhost:8000/docs"],
  },
});