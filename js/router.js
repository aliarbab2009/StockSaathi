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
import { renderResetPasswordRequest } from "./pages/resetPasswordRequest.js";
import { renderResetPassword } from "./pages/resetPassword.js";
import { renderFriends } from "./pages/friends.js";
import { renderNews } from "./pages/news.js";
import { renderChat } from "./pages/chat.js";
import { currentUser, refreshCurrentUser } from "./auth/accounts.js";
import { getState, subscribe } from "./state.js";

const ROUTES = [
  { name: "home",          match: /^$|^\/$/,                              render: renderLanding, public: true },
  { name: "login",         match: /^\/login\/?$/,                          render: renderLogin, public: true },
  { name: "register",      match: /^\/register\/?$/,                       render: renderRegister, public: true },
  { name: "reset-req",     match: /^\/reset-password-request\/?$/,         render: renderResetPasswordRequest, public: true },
  { name: "reset-password", match: /^\/reset-password\/?$/,                render: renderResetPassword, public: true },
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

// Loading shell shown while we wait for refreshCurrentUser to resolve. Plain
// spinner + a safety-net "log in" link for the rare case where the persisted
// session is actually corrupt and refresh will never fire.
function showLoadingShell() {
  const main = document.getElementById("main");
  if (!main) return;
  main.innerHTML = `
    <div class="empty-state" style="padding-top: var(--sp-12);">
      <div class="spinner" aria-hidden="true" style="margin: 0 auto var(--sp-4);"></div>
      <p class="dim" style="font-size: var(--text-sm);">Getting your portfolio ready…</p>
      <a href="#/login" class="dim text-xs" style="margin-top: var(--sp-4); display:inline-block;">Stuck? Log in manually</a>
    </div>
  `;
}

export function navigate(route) {
  location.hash = "#" + (route.startsWith("/") ? route : "/" + route);
}

// Strong sync signal that the user IS authed even if refreshCurrentUser
// hasn't populated the cache yet. A persisted Supabase session token is
// PROOF of auth — the JWT is already signed and dated, and the actual
// RPC calls will still 401 if it's expired. Avoids the "hard reload →
// flash of /login before state loads" we kept hitting.
function hasPersistedSession() {
  try { return !!localStorage.getItem("ss.sb.session.v1"); } catch { return false; }
}

// Deferred auth check: only redirects to /login if we're CONFIDENT the
// user isn't logged in. On page load, if refreshCurrentUser hasn't
// resolved yet but a Supabase session token is persisted, we subscribe
// to state changes and re-run the route guard when the cache fills —
// instead of bouncing to /login and letting the user click nav to
// recover. Also handles the needsOnboarded flicker the same way.
let _pendingRouteCheck = null;

export function mountRouter() {
  const main = document.getElementById("main");

  function route() {
    // Cancel any queued deferred check — we're about to re-evaluate fresh.
    if (_pendingRouteCheck) { _pendingRouteCheck(); _pendingRouteCheck = null; }

    const r = currentRoute();
    const user = currentUser();
    const state = getState();

    // needsAuth: if we don't know the user yet BUT a session token exists,
    // wait for refreshCurrentUser instead of redirecting. Only send them
    // to /login when we're sure they have no session at all.
    if (r.needsAuth && !user) {
      if (hasPersistedSession()) {
        showLoadingShell();
        const unsub = subscribe(() => {
          if (currentUser()) {
            cleanup();
            route();
          }
        });
        // Safety net: if refresh silently fails, fall through to /login
        // after 6s so users aren't stuck on a forever-spinner.
        const timer = setTimeout(() => {
          cleanup();
          if (!currentUser()) navigate("/login");
          else route();
        }, 6000);
        function cleanup() {
          unsub?.();
          clearTimeout(timer);
          if (_pendingRouteCheck === cleanup) _pendingRouteCheck = null;
        }
        _pendingRouteCheck = cleanup;
        return;
      }
      navigate("/login");
      return;
    }

    // needsOnboarded: same treatment. If we have a user object but the
    // profile fields (including `onboarded`) haven't loaded from the DB
    // yet, wait — don't bounce them to /onboarding mid-page-load.
    if (r.needsOnboarded && user && !state.user.onboarded && user._pendingRefresh) {
      showLoadingShell();
      const unsub = subscribe(() => {
        const u = currentUser();
        if (u && !u._pendingRefresh) { cleanup(); route(); }
      });
      const timer = setTimeout(() => { cleanup(); route(); }, 6000);
      function cleanup() {
        unsub?.();
        clearTimeout(timer);
        if (_pendingRouteCheck === cleanup) _pendingRouteCheck = null;
      }
      _pendingRouteCheck = cleanup;
      return;
    }
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
