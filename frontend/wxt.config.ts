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
    permissions: ["storage", "sidePanel", "activeTab"],
    // Host permissions are intentionally NOT wildcarded to all URLs -- this
    // previously said that in a comment while the array right below it
    // still had "https://*/*", which defeats the point. Scanning is
    // user-initiated on the active tab (see docs/ARCHITECTURE.md Non-goals:
    // "No automated crawling of sites at scale"), and the classify backend
    // only runs on localhost in dev, so localhost is genuinely all that's
    // needed here. Widen this deliberately (with a comment explaining why)
    // if/when the backend is deployed somewhere else.
    host_permissions: ["http://localhost/*"],
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
