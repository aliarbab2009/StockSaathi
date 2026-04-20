// =============================================================================
// NAV — StockSaathi top navigation, auth-aware + mobile drawer.
// =============================================================================

import { getState, subscribe, setSetting } from "../state.js";
import { logoutAccount } from "../auth/accounts.js";
import { formatRupees } from "../money.js";
import { marketStatus } from "../data/prices.js";
import { navigate, currentRoute } from "../router.js";
import { switchUser } from "../state.js";

const LINKS_AUTH = [
  { route: "portfolio", label: "Portfolio", icon: "📊" },
  { route: "stocks",    label: "Markets",   icon: "📈" },
  { route: "news",      label: "News",      icon: "📰" },
  { route: "chat",      label: "Coach Chat", icon: "💬" },
  { route: "crash-replay", label: "Time Travel", icon: "⏱" },
  { route: "leaderboard",  label: "Leaderboard", icon: "🏆" },
  { route: "friends",   label: "Friends",   icon: "👥" },
  { route: "report-card", label: "Report Card", icon: "📋" },
];

const LINKS_PUBLIC = [
  { route: "chat",         label: "Coach Chat", icon: "💬" },
  { route: "crash-replay", label: "Time Travel", icon: "⏱" },
  { route: "news",         label: "News",       icon: "📰" },
];

// Keep only the most important 5 in the top bar on desktop to prevent overflow
const DESKTOP_TOP5_AUTH = ["portfolio", "stocks", "news", "chat", "crash-replay"];

export function mountNav() {
  const root = document.getElementById("nav-root");
  if (!root) return;
  render();
  subscribe(render);
  window.addEventListener("hashchange", render);

  // Click-outside closes user dropdown
  document.addEventListener("click", (e) => {
    const dd = root.querySelector(".dropdown");
    if (dd && !dd.contains(e.target)) dd.classList.remove("open");
    const drawer = document.getElementById("nav-drawer");
    if (drawer?.classList.contains("open") &&
        !drawer.querySelector(".nav-drawer-panel").contains(e.target) &&
        !e.target.closest(".nav-burger")) {
      closeDrawer();
    }
  });

  // Close drawer on escape + on hashchange
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
  window.addEventListener("hashchange", closeDrawer);

  function render() {
    const state = getState();
    const active = currentRoute().name;
    const allLinks = state.isAuthed ? LINKS_AUTH : LINKS_PUBLIC;
    const topLinks = state.isAuthed
      ? allLinks.filter(l => DESKTOP_TOP5_AUTH.includes(l.route))
      : allLinks;
    const pfValue = state.isAuthed ? (state.portfolio.cashPaise + computeHoldingsValue(state)) : 0;
    const ms = marketStatus();

    root.innerHTML = `
      <div class="nav-inner">
        <a href="${state.isAuthed ? "#/portfolio" : "#/"}" class="brand-logo" aria-label="StockSaathi home">
          <span class="logo-mark">SS</span>
          <span>StockSaathi</span>
        </a>

        <nav class="nav-links" aria-label="Main navigation">
          ${topLinks.map(l => `
            <a href="#/${l.route}" class="nav-link ${active === l.route ? "active" : ""}">${l.label}</a>
          `).join("")}
        </nav>

        <div class="nav-right">
          ${themeToggleHtml(state.settings.theme)}
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
          <button class="nav-burger" aria-label="Open menu" id="nav-burger-btn">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M4 7h16M4 12h16M4 17h16"/>
            </svg>
          </button>
        </div>
      </div>
    `;

    ensureDrawer();
    renderDrawer(state, allLinks, active, pfValue, ms);

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
    root.querySelector("#nav-burger-btn")?.addEventListener("click", openDrawer);
    root.querySelector("#theme-toggle-btn")?.addEventListener("click", toggleTheme);
  }
}

// Site-wide theme toggle. Accessible from every page without diving into
// Settings. State change propagates via the existing subscribe() wired
// in app.js, which flips the <html data-theme="…"> attribute, which all
// CSS vars are keyed off.
function toggleTheme() {
  const cur = getState().settings.theme || "light";
  const next = cur === "dark" ? "light" : "dark";
  setSetting("theme", next);
}

function themeToggleHtml(theme) {
  const isDark = (theme || "light") === "dark";
  // Sun icon when dark (click → go light), moon when light (click → go dark).
  const icon = isDark
    ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`
    : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  return `<button id="theme-toggle-btn" class="nav-theme-toggle" type="button" aria-label="${isDark ? "Switch to light mode" : "Switch to dark mode"}" title="${isDark ? "Switch to light mode" : "Switch to dark mode"}">${icon}</button>`;
}

// ---------------------------------------------------------------------------
// Mobile drawer
// ---------------------------------------------------------------------------

function ensureDrawer() {
  if (document.getElementById("nav-drawer")) return;
  const drawer = document.createElement("div");
  drawer.id = "nav-drawer";
  drawer.className = "nav-drawer";
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-hidden", "true");
  drawer.innerHTML = `
    <div class="nav-drawer-backdrop" data-close></div>
    <div class="nav-drawer-panel"></div>
  `;
  document.body.appendChild(drawer);
  drawer.querySelector("[data-close]").addEventListener("click", closeDrawer);
}

function renderDrawer(state, allLinks, active, pfValue, ms) {
  const drawer = document.getElementById("nav-drawer");
  if (!drawer) return;
  const panel = drawer.querySelector(".nav-drawer-panel");
  panel.innerHTML = `
    <div class="drawer-head">
      <div class="brand-logo">
        <span class="logo-mark">SS</span>
        <span>StockSaathi</span>
      </div>
      <button class="btn btn-ghost btn-icon" aria-label="Close menu" data-close-drawer>✕</button>
    </div>

    ${state.isAuthed ? `
      <div class="drawer-stat">
        <div class="muted text-xs" style="text-transform: uppercase; letter-spacing: 0.05em;">Portfolio</div>
        <div class="val">${formatRupees(pfValue, { compact: true })}</div>
        <div class="text-xs ${ms.open ? "up" : "muted"}" style="margin-top: 4px;">
          ${ms.open ? "● Market open" : "○ Market closed"} · ${ms.istTime}
        </div>
      </div>
    ` : ""}

    <div class="drawer-section">Navigate</div>
    ${allLinks.map(l => `
      <a href="#/${l.route}" class="drawer-link ${active === l.route ? "active" : ""}" data-close-on-click>
        <span>${l.icon} ${l.label}</span>
        <span class="muted">›</span>
      </a>
    `).join("")}

    <div class="drawer-divider"></div>
    <button class="drawer-link" id="drawer-theme-toggle" type="button" style="text-align: left;">
      <span>${(state.settings.theme || "light") === "dark" ? "☀️ Light mode" : "🌙 Dark mode"}</span>
      <span class="muted">↔</span>
    </button>

    ${state.isAuthed ? `
      <div class="drawer-divider"></div>
      <div class="drawer-section">${escapeHtml(state.user.displayName || state.user.username || "")}</div>
      <a href="#/settings" class="drawer-link" data-close-on-click>
        <span>⚙️ Settings</span>
        <span class="muted">›</span>
      </a>
      <button class="drawer-link" id="drawer-logout" style="text-align: left; color: var(--negative);">
        <span>↪ Log out</span>
      </button>
    ` : `
      <div class="drawer-divider"></div>
      <a href="#/login" class="drawer-link" data-close-on-click>
        <span>Log in</span>
        <span class="muted">›</span>
      </a>
      <a href="#/register" class="drawer-link" data-close-on-click style="color: var(--brand);">
        <span>Create account</span>
        <span class="muted">›</span>
      </a>
    `}
  `;

  panel.querySelectorAll("[data-close-on-click]").forEach(el =>
    el.addEventListener("click", closeDrawer)
  );
  panel.querySelector("[data-close-drawer]")?.addEventListener("click", closeDrawer);
  panel.querySelector("#drawer-theme-toggle")?.addEventListener("click", toggleTheme);
  panel.querySelector("#drawer-logout")?.addEventListener("click", () => {
    logoutAccount();
    switchUser();
    closeDrawer();
    navigate("/");
  });
}

function openDrawer() {
  const drawer = document.getElementById("nav-drawer");
  if (!drawer) return;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  document.body.classList.add("scroll-lock");
}
function closeDrawer() {
  const drawer = document.getElementById("nav-drawer");
  if (!drawer) return;
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  document.body.classList.remove("scroll-lock");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function computeHoldingsValue(state) {
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
