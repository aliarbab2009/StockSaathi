// =============================================================================
// APP ENTRY — Theme bootstrap, nav, coach, router, service worker.
// =============================================================================

import { getState, subscribe, setSetting, switchUser } from "./state.js";
import { mountNav } from "./components/nav.js";
import { mountCoachPanel } from "./components/coachPanel.js";
import { mountRouter } from "./router.js";
import { currentUser } from "./auth/accounts.js";

// Theme ASAP to avoid flash
(function applyTheme() {
  const theme = getState().settings.theme || "light";
  document.documentElement.setAttribute("data-theme", theme);
})();

// Load user-scoped state on boot
switchUser();

// Mount components
mountNav();
mountCoachPanel();
mountRouter();

// Reactively sync theme
subscribe((s) => {
  document.documentElement.setAttribute("data-theme", s.settings.theme || "light");
});

// Service worker (offline)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(err => {
      console.warn("SW registration failed (non-critical):", err);
    });
  });
}

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "/" && location.hash.startsWith("#/stocks")) {
    e.preventDefault();
    document.querySelector("#stocks-search")?.focus();
  }
  if (e.key === "c" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    setSetting("coachPanelOpen", !getState().settings.coachPanelOpen);
  }
});

console.log("%cStockSaathi", "color: #00B386; font-size: 22px; font-weight: 800;");
console.log("%cInvest virtually. Learn for real. No external deps, fully offline-capable.",
  "color: #5C6473; font-size: 12px;");
