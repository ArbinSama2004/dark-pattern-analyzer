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
    // A shield (the extension protects you from manipulation) carrying a
    // warning mark (it flags, it does not block). Deliberately not an eye or a
    // magnifying glass: an eye reads as surveillance, which is the opposite of
    // what this does, and a lens turns to mush at 16px.
    //
    // Generated from a 1024px master and downsampled, so the shield's diagonal
    // edges stay clean at toolbar size. Source parameters are in the commit
    // that added these files; re-render rather than hand-editing a PNG.
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      96: "icon/96.png",
      128: "icon/128.png",
    },
    action: {
      default_title: "Dark Pattern Analyzer",
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png",
        128: "icon/128.png",
      },
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