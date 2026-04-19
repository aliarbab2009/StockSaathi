// =============================================================================
// NAV — StockSaathi top navigation, auth-aware.
// =============================================================================

import { getState, subscribe, setSetting } from "../state.js";
import { logoutAccount } from "../auth/accounts.js";
import { formatRupees } from "../money.js";
import { marketStatus } from "../data/prices.js";
import { navigate, currentRoute } from "../router.js";
import { switchUser } from "../state.js";

const LINKS_AUTH = [
  { route: "portfolio", label: "Portfolio" },
  { route: "stocks",    label: "Markets" },
  { route: "news",      label: "News" },
  { route: "chat",      label: "Coach Chat" },
  { route: "crash-replay", label: "Time Travel" },
  { route: "leaderboard",  label: "Leaderboard" },
  { route: "friends",   label: "Friends" },
];

const LINKS_PUBLIC = [
  { route: "chat",         label: "Coach Chat" },
  { route: "crash-replay", label: "Time Travel" },
  { route: "news",         label: "News" },
];

export function mountNav() {
  const root = document.getElementById("nav-root");
  if (!root) return;
  render();
  subscribe(render);
  window.addEventListener("hashchange", render);

  // Click-outside closes dropdown
  document.addEventListener("click", (e) => {
    const dd = root.querySelector(".dropdown");
    if (dd && !dd.contains(e.target)) dd.classList.remove("open");
  });

  function render() {
    const state = getState();
    const active = currentRoute().name;
    const links = state.isAuthed ? LINKS_AUTH : LINKS_PUBLIC;
    const pfValue = state.isAuthed ? (state.portfolio.cashPaise + computeHoldingsValue(state)) : 0;
    const ms = marketStatus();

    root.innerHTML = `
      <div class="nav-inner">
        <a href="${state.isAuthed ? "#/portfolio" : "#/"}" class="brand-logo" aria-label="StockSaathi">
          <span class="logo-mark">SS</span>
          <span>StockSaathi</span>
        </a>

        <nav class="nav-links" aria-label="Main">
          ${links.map(l => `
            <a href="#/${l.route}" class="nav-link ${active === l.route ? "active" : ""}">${l.label}</a>
          `).join("")}
        </nav>

        <div class="nav-right">
          ${state.isAuthed ? `
            <div class="market-status" title="${ms.istTime}"><span class="dot ${ms.open ? "" : "closed"}"></span><span class="muted">${ms.open ? "Live" : "Closed"}</span></div>
            <div class="nav-cash" aria-label="Portfolio value">
              <span class="label">Portfolio</span>
              <span class="val tabular">${formatRupees(pfValue, { compact: true })}</span>
            </div>
            <div class="dropdown" id="user-dd">
              <button class="nav-avatar" id="user-avatar" aria-label="Account menu" aria-expanded="false">
                ${initials(state.user.displayName || state.user.username)}
              </button>
              <div class="dropdown-menu" role="menu">
                <div style="padding: 10px 12px;">
                  <div class="font-semi">${escapeHtml(state.user.displayName || "")}</div>
                  <div class="muted text-xs">@${escapeHtml(state.user.username || "")}</div>
                </div>
                <div class="dropdown-divider"></div>
                <a class="dropdown-item" href="#/report-card">📋 Report card</a>
                <a class="dropdown-item" href="#/friends">👥 Friends & transfers</a>
                <a class="dropdown-item" href="#/settings">⚙️ Settings</a>
                <div class="dropdown-divider"></div>
                <button class="dropdown-item danger" id="logout-btn">Log out</button>
              </div>
            </div>
          ` : `
            <a href="#/login" class="btn btn-ghost btn-sm">Log in</a>
            <a href="#/register" class="btn btn-primary btn-sm">Sign up</a>
          `}
        </div>
      </div>
    `;

    const avatar = root.querySelector("#user-avatar");
    const dd = root.querySelector("#user-dd");
    avatar?.addEventListener("click", (e) => {
      e.stopPropagation();
      dd.classList.toggle("open");
      avatar.setAttribute("aria-expanded", dd.classList.contains("open"));
    });
    root.querySelector("#logout-btn")?.addEventListener("click", () => {
      logoutAccount();
      switchUser();
      navigate("/");
    });
  }
}

function computeHoldingsValue(state) {
  // Lazy dep; using avg cost as conservative proxy — real numbers come from state.js
  let total = 0;
  for (const [sym, h] of Object.entries(state.holdings || {})) {
    total += Math.round(h.qty * h.avgCostPaise);
  }
  return total;
}

function initials(name) {
  if (!name) return "S";
  const parts = String(name).trim().split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
