// =============================================================================
// ROUTER — Hash-based. Auth-aware. Clean auth/onboarding/protected split.
// =============================================================================

import { renderLanding } from "./pages/landing.js";
import { renderPortfolio } from "./pages/portfolio.js";
import { renderStocks } from "./pages/stocks.js";
import { renderStockDetail } from "./pages/stockDetail.js";
import { renderCrashReplay } from "./pages/crashReplay.js";
import { renderLeaderboard } from "./pages/leaderboard.js";
import { renderReportCard } from "./pages/reportCard.js";
import { renderOnboarding } from "./pages/onboarding.js";
import { renderSettings } from "./pages/settings.js";
import { renderLogin } from "./pages/login.js";
import { renderRegister } from "./pages/register.js";
import { renderFriends } from "./pages/friends.js";
import { renderNews } from "./pages/news.js";
import { renderChat } from "./pages/chat.js";
import { currentUser, refreshCurrentUser } from "./auth/accounts.js";
import { getState } from "./state.js";

const ROUTES = [
  { name: "home",          match: /^$|^\/$/,                              render: renderLanding, public: true },
  { name: "login",         match: /^\/login\/?$/,                          render: renderLogin, public: true },
  { name: "register",      match: /^\/register\/?$/,                       render: renderRegister, public: true },
  { name: "onboarding",    match: /^\/onboarding\/?$/,                     render: renderOnboarding, needsAuth: true },
  { name: "portfolio",     match: /^\/portfolio\/?$/,                      render: renderPortfolio, needsAuth: true, needsOnboarded: true },
  { name: "stocks",        match: /^\/stocks\/?$/,                         render: renderStocks, needsAuth: true, needsOnboarded: true },
  { name: "stock-detail",  match: /^\/stocks\/([A-Za-z0-9&\-_.]+)\/?$/,    render: renderStockDetail, param: "symbol", needsAuth: true, needsOnboarded: true },
  { name: "crash-replay",  match: /^\/crash-replay\/?$/,                   render: renderCrashReplay, public: true },
  { name: "crash-replay-scenario", match: /^\/crash-replay\/([A-Z_0-9]+)\/?$/, render: renderCrashReplay, param: "scenario", public: true },
  { name: "leaderboard",   match: /^\/leaderboard\/?$/,                    render: renderLeaderboard, needsAuth: true, needsOnboarded: true },
  { name: "report-card",   match: /^\/report-card\/?$/,                    render: renderReportCard, needsAuth: true, needsOnboarded: true },
  { name: "friends",       match: /^\/friends\/?$/,                        render: renderFriends, needsAuth: true, needsOnboarded: true },
  { name: "news",          match: /^\/news\/?$/,                           render: renderNews, public: true },
  { name: "chat",          match: /^\/chat\/?$/,                           render: renderChat, public: true },
  { name: "settings",      match: /^\/settings\/?$/,                       render: renderSettings, needsAuth: true },
];

export function currentRoute() {
  const hash = location.hash.slice(1) || "/";
  const pathOnly = hash.split("?")[0];
  for (const r of ROUTES) {
    const m = pathOnly.match(r.match);
    if (m) {
      const p = {};
      if (r.param) p[r.param] = decodeURIComponent(m[1]);
      return { ...r, params: p };
    }
  }
  return { name: "404", params: {}, render: render404, public: true };
}

function render404(main) {
  main.innerHTML = `
    <div class="empty-state">
      <span class="emoji">🔍</span>
      <h3>Page not found</h3>
      <p>The route you tried doesn't exist.</p>
      <a href="#/" class="btn btn-primary">Back home</a>
    </div>
  `;
}

export function navigate(route) {
  location.hash = "#" + (route.startsWith("/") ? route : "/" + route);
}

export function mountRouter() {
  const main = document.getElementById("main");

  function route() {
    const r = currentRoute();
    const user = currentUser();
    const state = getState();

    // Auth guards
    if (r.needsAuth && !user) { navigate("/login"); return; }
    if (r.needsOnboarded && user && !state.user.onboarded) { navigate("/onboarding"); return; }

    main.innerHTML = "";
    main.classList.remove("page-enter");
    void main.offsetWidth;
    main.classList.add("page-enter");
    // Error boundary — a single page throw used to blank the whole UI.
    // Now the user sees a recoverable "something went wrong" card with a
    // retry button, and the error is logged to the console for debugging.
    try {
      r.render(main, r.params);
    } catch (err) {
      console.error(`[router] ${r.name} render failed:`, err);
      main.innerHTML = `
        <div class="empty-state">
          <span class="emoji" aria-hidden="true">⚠</span>
          <h3>Something broke on this page</h3>
          <p class="dim">We logged the error. You can reload or go back.</p>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px;">
            <button class="btn btn-primary" id="route-retry">Reload page</button>
            <a href="#/" class="btn btn-outline">Go home</a>
          </div>
        </div>
      `;
      main.querySelector("#route-retry")?.addEventListener("click", () => {
        window.location.reload();
      });
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  window.addEventListener("hashchange", route);
  route();
}
