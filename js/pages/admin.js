// =============================================================================
// ADMIN GOD-MODE PANEL
// Nine-tab unified ops console at /#/a/<ADMIN_PATH>. Replaces the owner's
// need to open Supabase Studio, Vercel Dashboard, or GitHub Web UI for
// routine operations.
//
// Tabs:
//   Overview   — aggregate health across all three services
//   Users      — every user x every column x filterable/sortable/drill-down
//   Activity   — live-tailing SSE feed of every event
//   Database   — Supabase god mode (SQL editor, table CRUD, RPC runner)
//   Auth       — Supabase Auth admin (list, reset, ban, magic link)
//   Markets    — quote_cache + ai_response_cache + dhan coverage
//   Deploy     — Vercel deployments + logs + envs + redeploy + rollback
//   Repo       — GitHub commits + PRs + issues + Actions + workflow dispatch
//   Audit      — every admin write with before/after diff
//
// Gated by ADMIN_PATH (URL slug) + ADMIN_TOKEN (bearer). Each tab's detail
// code lives in separate modules under /js/pages/admin/ where the module
// count justifies; for now, everything's inline here and will split later
// if the file grows unwieldy.
// =============================================================================

import { formatRupees } from "../money.js";
import { areaChart } from "../components/charts.js";
import { toast } from "../components/toast.js";

const TOKEN_KEY = "ss.adminToken.v1";
const LAST_TAB_KEY = "ss.adminLastTab.v1";

// Shared fetch state so tabs don't re-fetch on every switch.
const state = {
  overview: null,
  overviewLoading: false,
  overviewError: null,
  activity: [],
  activityFilter: "all",     // trades | coach | transfers | orders | signups | all
  activityPaused: false,
  tail: null,                // EventSource instance
  tailConnected: false,
  userDetail: null,
  userDetailLoading: false,
  filters: {
    search: "",
    onboarded: "any",         // any | yes | no
    riskProfile: "any",       // any | cautious | balanced | bold
    consent: "any",           // any | yes | no
    traded: "any",            // any | yes | no
    coached: "any",           // any | yes | no
    ageBracket: "any",        // any | 13-15 | 16-17 | 18+
    tradeBucket: "any",       // any | 0 | 1-5 | 6-20 | 20+
    activity: "any",          // any | <1d | <7d | <30d | 30d+
    school: "any",            // any | <specific school name>
  },
  sort: { by: "createdAt", dir: "desc" },
};

let currentTab = "overview";

// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------
export function renderAdmin(main, params) {
  const slug = params?.slug || "";
  if (!slug) return render404Like(main);

  renderLoadingShell(main);
  fetch("/api/ai?op=admin-path-check&slug=" + encodeURIComponent(slug))
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data?.ok) return render404Like(main);
      if (!getToken()) return renderTokenForm(main);
      currentTab = getLastTab() || "overview";
      renderTabbedShell(main);
    })
    .catch(() => render404Like(main));
}

function render404Like(main) {
  main.innerHTML = `
    <div class="empty-state" style="padding: 12vh var(--sp-4);">
      <span class="emoji">🔍</span>
      <h3>Page not found</h3>
      <p class="muted">The route you tried doesn't exist.</p>
      <a href="#/" class="btn btn-primary">Back home</a>
    </div>`;
}
function renderLoadingShell(main) {
  main.innerHTML = `<div class="card" style="max-width: 420px; margin: 10vh auto; text-align:center; padding: var(--sp-5);"><div class="muted">Loading…</div></div>`;
}

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } }
function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch {} }
function getLastTab() { try { return localStorage.getItem(LAST_TAB_KEY); } catch { return null; } }
function setLastTab(t) { try { localStorage.setItem(LAST_TAB_KEY, t); } catch {} }

function renderTokenForm(main) {
  main.innerHTML = `
    <div style="max-width: 520px; margin: 10vh auto;">
      <div class="card">
        <h2 style="margin-top: 0;">Admin access</h2>
        <p class="muted" style="line-height: 1.6;">
          Paste the ADMIN_TOKEN you set on Vercel. Stored in localStorage on this
          device only; sent as a Bearer header on every admin API call.
        </p>
        <div class="field">
          <label class="label" for="admin-token">ADMIN_TOKEN</label>
          <input class="input" id="admin-token" type="password" autocomplete="off" />
        </div>
        <div class="flex gap-2" style="margin-top: var(--sp-3);">
          <button id="admin-token-save" class="btn btn-primary">Unlock</button>
          <a href="#/" class="btn btn-ghost">Cancel</a>
        </div>
      </div>
    </div>`;
  const input = main.querySelector("#admin-token");
  input.focus();
  const submit = async () => {
    const t = input.value.trim();
    if (!t) return;
    setToken(t);
    try {
      await loadOverview();
      if (!state.overview) throw new Error(state.overviewError || "rejected");
      renderTabbedShell(main);
    } catch (e) {
      setToken("");
      toast({ kind: "error", message: "Token rejected — try again." });
      renderTokenForm(main);
    }
  };
  main.querySelector("#admin-token-save").addEventListener("click", submit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
}

// -----------------------------------------------------------------------------
// Shared HTTP helpers
// -----------------------------------------------------------------------------
async function adminGet(path) {
  const token = getToken();
  const r = await fetch(path, { headers: { "Authorization": "Bearer " + token } });
  if (r.status === 401) { setToken(""); throw new Error("Unauthorised — sign in again."); }
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function adminPost(path, body) {
  const token = getToken();
  const r = await fetch(path, {
    method: "POST",
    headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 401) { setToken(""); throw new Error("Unauthorised — sign in again."); }
  const rb = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(rb?.error || ("HTTP " + r.status));
  return rb;
}

async function loadOverview() {
  state.overviewLoading = true;
  state.overviewError = null;
  try { state.overview = await adminGet("/api/ai?op=admin-overview"); }
  catch (e) { state.overviewError = e.message || String(e); state.overview = null; throw e; }
  finally { state.overviewLoading = false; }
}

// -----------------------------------------------------------------------------
// Tabbed shell
// -----------------------------------------------------------------------------
function renderTabbedShell(main) {
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "users",    label: "Users" },
    { id: "activity", label: "Activity" },
    { id: "database", label: "Database" },
    { id: "auth",     label: "Auth" },
    { id: "markets",  label: "Markets" },
    { id: "deploy",   label: "Deploy" },
    { id: "repo",     label: "Repo" },
    { id: "audit",    label: "Audit" },
  ];
  main.innerHTML = `
    <div class="admin-shell">
      <header class="admin-shell-head">
        <div>
          <h1 style="margin:0;">Admin</h1>
          <p class="muted" style="margin:4px 0 0 0;">God-mode ops. Every write is audit-logged.</p>
        </div>
        <div class="flex gap-2 items-center">
          <span id="tail-indicator" class="tail-indicator ${state.tailConnected ? "live" : "off"}">${state.tailConnected ? "● LIVE" : "○ paused"}</span>
          <button class="btn btn-ghost btn-sm" id="tail-toggle">${state.tailConnected ? "Pause tail" : "Live tail"}</button>
          <button class="btn btn-ghost btn-sm" id="admin-refresh">↻ Refresh</button>
          <button class="btn btn-ghost btn-sm" id="admin-logout">Sign out</button>
        </div>
      </header>
      <nav class="admin-tabs">
        ${tabs.map(t => `<button class="admin-tab ${currentTab === t.id ? "active" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
      </nav>
      <div class="admin-tab-body" id="admin-tab-body"></div>
    </div>`;
  main.querySelectorAll(".admin-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      currentTab = btn.dataset.tab;
      setLastTab(currentTab);
      renderTabBody(main);
      main.querySelectorAll(".admin-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === currentTab));
    });
  });
  main.querySelector("#admin-refresh").addEventListener("click", async () => {
    await loadOverview().catch(() => {});
    renderTabBody(main);
  });
  main.querySelector("#admin-logout").addEventListener("click", () => {
    setToken("");
    closeTail();
    state.overview = null;
    renderTokenForm(main);
  });
  main.querySelector("#tail-toggle").addEventListener("click", () => {
    if (state.tailConnected) closeTail(); else openTail(main);
    updateTailBadge(main);
  });
  renderTabBody(main);
}

function renderTabBody(main) {
  const host = main.querySelector("#admin-tab-body");
  if (!host) return;
  host.innerHTML = "";
  switch (currentTab) {
    case "overview": return renderOverview(host, main);
    case "users":    return renderUsersTab(host, main);
    case "activity": return renderActivityTab(host, main);
    case "database": return renderDatabaseTab(host, main);
    case "auth":     return renderAuthTab(host, main);
    case "markets":  return renderPlaceholder(host, "Markets / AI cache", "Coming in next commit.");
    case "deploy":   return renderPlaceholder(host, "Deploy (Vercel)", "Coming in next commit.");
    case "repo":     return renderPlaceholder(host, "Repo (GitHub)", "Coming in next commit.");
    case "audit":    return renderPlaceholder(host, "Audit log", "Coming in next commit.");
    default:         return renderOverview(host, main);
  }
}

function renderPlaceholder(host, title, hint) {
  host.innerHTML = `<div class="card" style="text-align:center; padding: var(--sp-6);"><h3>${escapeHtml(title)}</h3><p class="muted">${escapeHtml(hint)}</p></div>`;
}

// -----------------------------------------------------------------------------
// Overview tab
// -----------------------------------------------------------------------------
function renderOverview(host, main) {
  if (!state.overview && !state.overviewLoading) {
    loadOverview().catch(() => {}).finally(() => renderTabBody(main));
  }
  if (state.overviewLoading && !state.overview) {
    host.innerHTML = `<div class="card"><div class="muted">Loading overview…</div></div>`;
    return;
  }
  if (!state.overview) {
    host.innerHTML = `<div class="card"><div style="color: var(--negative);">${escapeHtml(state.overviewError || "Failed to load.")}</div></div>`;
    return;
  }
  const { aggregates: a, byDay, top, rowCounts } = state.overview;
  const maxDay = byDay.reduce((b, c) => c.count > b.count ? c : b, { count: 0, day: "" });
  const signupChart = areaChart(byDay.map(d => d.count), { height: 80, color: "var(--brand)", paddingLeft: 0 });
  host.innerHTML = `
    <div class="admin-stats">
      <div class="stat-tile"><div class="l">Users</div><div class="v tabular">${a.users}</div></div>
      <div class="stat-tile"><div class="l">Onboarded</div><div class="v tabular">${a.onboarded} <span class="dim text-sm">(${a.onboardedPct}%)</span></div></div>
      <div class="stat-tile"><div class="l">Traded ever</div><div class="v tabular">${a.active} <span class="dim text-sm">(${a.activePct}%)</span></div></div>
      <div class="stat-tile"><div class="l">Consented</div><div class="v tabular">${a.consented}</div></div>
      <div class="stat-tile"><div class="l">Total portfolio</div><div class="v tabular">${formatRupees((a.totalPortfolioRupees || 0) * 100, { compact: true })}</div></div>
      <div class="stat-tile"><div class="l">Total cash</div><div class="v tabular">${formatRupees(a.totalCashRupees * 100, { compact: true })}</div></div>
      <div class="stat-tile"><div class="l">Total trades</div><div class="v tabular">${a.totalTrades}</div></div>
      <div class="stat-tile"><div class="l">Coach msgs</div><div class="v tabular">${a.totalCoachMessages}</div></div>
    </div>

    <div class="card" style="margin-top: var(--sp-4);">
      <div class="card-head"><h3>Sign-ups · last 30 days</h3><span class="dim text-sm">Peak: ${maxDay.count || 0} on ${escapeHtml(maxDay.day || "—")}</span></div>
      <div style="height: 80px;">${signupChart}</div>
    </div>

    <div class="admin-overview-grid" style="margin-top: var(--sp-4);">
      <div class="card">
        <div class="card-head"><h3>Row counts (every table)</h3></div>
        <div class="admin-row-counts">
          ${Object.entries(rowCounts).map(([k, v]) => `<div class="admin-kv"><span>${escapeHtml(k)}</span><span class="tabular">${v}</span></div>`).join("")}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Top portfolios</h3></div>
        ${renderLeaderboard(top.biggestPortfolios, v => formatRupees(v * 100, { compact: true }))}
      </div>
      <div class="card">
        <div class="card-head"><h3>Most active (trades)</h3></div>
        ${renderLeaderboard(top.mostActive, v => v + " trades")}
      </div>
      <div class="card">
        <div class="card-head"><h3>Most coached</h3></div>
        ${renderLeaderboard(top.mostCoached, v => v + " msgs")}
      </div>
      <div class="card">
        <div class="card-head"><h3>Biggest gainers</h3></div>
        ${renderLeaderboard(top.biggestGainers, v => (v >= 0 ? "+" : "") + v.toFixed(1) + "%")}
      </div>
      <div class="card">
        <div class="card-head"><h3>Biggest losers</h3></div>
        ${renderLeaderboard(top.biggestLosers, v => v.toFixed(1) + "%")}
      </div>
    </div>`;
}
function renderLeaderboard(rows, fmt) {
  if (!rows?.length) return `<div class="muted text-sm" style="padding: var(--sp-3);">No data yet.</div>`;
  return `<ol class="admin-lb">${rows.map(r => `<li><a href="#" data-open-user="${escapeAttr(r.id)}">@${escapeHtml(r.username || "?")}</a><span class="tabular">${escapeHtml(fmt(r.value))}</span></li>`).join("")}</ol>`;
}

// -----------------------------------------------------------------------------
// Users tab
// -----------------------------------------------------------------------------
function renderUsersTab(host, main) {
  if (!state.overview && !state.overviewLoading) {
    loadOverview().catch(() => {}).finally(() => renderTabBody(main));
  }
  if (state.overviewLoading && !state.overview) {
    host.innerHTML = `<div class="card"><div class="muted">Loading users…</div></div>`;
    return;
  }
  if (!state.overview) return;
  const users = state.overview.users || [];
  const list = applyFiltersAndSort(users);
  const schools = [...new Set(users.map(u => u.school).filter(Boolean))].sort();

  host.innerHTML = `
    <div class="admin-filter-bar card" style="margin-bottom: var(--sp-3);">
      <input id="u-search" class="input" placeholder="Search username / name / email / school / city" value="${escapeAttr(state.filters.search)}" style="flex:1; min-width: 240px;" />
      <select id="u-onboarded" class="select">
        <option value="any">Onboarded: any</option>
        <option value="yes" ${state.filters.onboarded === "yes" ? "selected" : ""}>Onboarded: yes</option>
        <option value="no"  ${state.filters.onboarded === "no"  ? "selected" : ""}>Onboarded: no</option>
      </select>
      <select id="u-risk" class="select">
        <option value="any">Risk: any</option>
        <option value="cautious">Cautious</option>
        <option value="balanced">Balanced</option>
        <option value="bold">Bold</option>
      </select>
      <select id="u-consent" class="select">
        <option value="any">Consent: any</option>
        <option value="yes">Consented</option>
        <option value="no">No consent</option>
      </select>
      <select id="u-traded" class="select">
        <option value="any">Trading: any</option>
        <option value="yes">Has traded</option>
        <option value="no">Zero trades</option>
      </select>
      <select id="u-coached" class="select">
        <option value="any">Coach msgs: any</option>
        <option value="yes">Has coach msgs</option>
        <option value="no">No coach msgs</option>
      </select>
      <select id="u-age" class="select">
        <option value="any">Age: any</option>
        <option value="13-15">13–15</option>
        <option value="16-17">16–17</option>
        <option value="18+">18+</option>
      </select>
      <select id="u-trades" class="select">
        <option value="any">Trade count: any</option>
        <option value="0">0</option>
        <option value="1-5">1–5</option>
        <option value="6-20">6–20</option>
        <option value="20+">20+</option>
      </select>
      <select id="u-activity" class="select">
        <option value="any">Activity: any</option>
        <option value="<1d">Active &lt; 1d</option>
        <option value="<7d">Active &lt; 7d</option>
        <option value="<30d">Active &lt; 30d</option>
        <option value="30d+">Stale 30d+</option>
      </select>
      <select id="u-school" class="select">
        <option value="any">School: any</option>
        ${schools.map(s => `<option ${state.filters.school === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}
      </select>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>Users (${list.length} of ${users.length})</h3>
        <div class="dim text-xs">Click header to sort · click row for drill-down</div>
      </div>
      <div class="admin-table-wrap">
        ${renderUsersTable(list)}
      </div>
    </div>`;

  // Wire filters
  const setF = (key, val) => {
    state.filters[key] = val;
    renderTabBody(main);
  };
  host.querySelector("#u-search").addEventListener("input", e => {
    state.filters.search = e.target.value;
    const tbody = host.querySelector(".admin-table tbody");
    if (tbody) tbody.innerHTML = renderUsersRowsHtml(applyFiltersAndSort(users));
    wireRowClicks(host, main);
  });
  host.querySelector("#u-onboarded").addEventListener("change", e => setF("onboarded", e.target.value));
  host.querySelector("#u-risk").addEventListener("change", e => setF("riskProfile", e.target.value));
  host.querySelector("#u-consent").addEventListener("change", e => setF("consent", e.target.value));
  host.querySelector("#u-traded").addEventListener("change", e => setF("traded", e.target.value));
  host.querySelector("#u-coached").addEventListener("change", e => setF("coached", e.target.value));
  host.querySelector("#u-age").addEventListener("change", e => setF("ageBracket", e.target.value));
  host.querySelector("#u-trades").addEventListener("change", e => setF("tradeBucket", e.target.value));
  host.querySelector("#u-activity").addEventListener("change", e => setF("activity", e.target.value));
  host.querySelector("#u-school").addEventListener("change", e => setF("school", e.target.value));

  host.querySelectorAll(".admin-table th[data-col]").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (state.sort.by === col) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else { state.sort.by = col; state.sort.dir = "desc"; }
      renderTabBody(main);
    });
  });
  wireRowClicks(host, main);
}

// 27-column sortable user table
function renderUsersTable(list) {
  const cols = [
    ["user", "User"],
    ["createdAt", "Joined"],
    ["onboarded", "OB"],
    ["age", "Age"],
    ["school", "School"],
    ["riskProfile", "Risk"],
    ["tradeCount", "Trades"],
    ["coachMsgCount", "Coach"],
    ["holdingCount", "Hold"],
    ["friendCount", "Friends"],
    ["watchlistCount", "WL"],
    ["limitOrderCount", "LO"],
    ["biasFlagCount", "Biases"],
    ["transferInCount", "In"],
    ["transferOutCount", "Out"],
    ["cashRupees", "Cash"],
    ["totalPortfolioRupees", "Portfolio"],
    ["unrealizedPLPct", "P/L%"],
    ["totalTradedValueRupees", "Vol"],
    ["daysSinceLastTrade", "Idle"],
    ["lastActive", "Active"],
  ];
  return `<table class="admin-table">
    <thead><tr>${cols.map(([col, label]) => colHead(col, label)).join("")}<th>Act</th></tr></thead>
    <tbody>${renderUsersRowsHtml(list)}</tbody>
  </table>`;
}
function renderUsersRowsHtml(list) {
  return list.slice(0, 500).map(u => `
    <tr data-user-id="${escapeAttr(u.id)}">
      <td><div class="font-semi">${escapeHtml(u.displayName || u.username)}</div>
          <div class="dim text-xs">@${escapeHtml(u.username || "")} · ${escapeHtml(u.email || "")}</div></td>
      <td class="dim text-xs">${formatDateShort(u.createdAt)}</td>
      <td>${u.onboarded ? '<span class="pill pill-green" style="font-size:10px;">OB</span>' : '<span class="pill" style="font-size:10px;background:var(--bg-subtle);color:var(--text-dim);">NEW</span>'}</td>
      <td class="dim">${u.age ?? "—"}</td>
      <td class="dim text-xs">${escapeHtml(u.school || "—")}</td>
      <td class="dim text-xs">${escapeHtml(u.riskProfile || "—")}</td>
      <td class="tabular">${u.tradeCount}</td>
      <td class="tabular">${u.coachMsgCount}</td>
      <td class="tabular">${u.holdingCount}</td>
      <td class="tabular">${u.friendCount}</td>
      <td class="tabular">${u.watchlistCount}</td>
      <td class="tabular">${u.limitOrderCount}</td>
      <td class="tabular">${u.biasFlagCount}</td>
      <td class="tabular">${u.transferInCount}</td>
      <td class="tabular">${u.transferOutCount}</td>
      <td class="tabular">${u.cashRupees != null ? formatRupees(u.cashRupees * 100, { compact: true }) : "—"}</td>
      <td class="tabular">${u.totalPortfolioRupees ? formatRupees(u.totalPortfolioRupees * 100, { compact: true }) : "—"}</td>
      <td class="tabular ${u.unrealizedPLPct >= 0 ? "positive" : "negative"}">${u.unrealizedPLPct >= 0 ? "+" : ""}${u.unrealizedPLPct.toFixed(1)}%</td>
      <td class="tabular">${u.totalTradedValueRupees ? formatRupees(u.totalTradedValueRupees * 100, { compact: true }) : "—"}</td>
      <td class="tabular">${u.daysSinceLastTrade != null ? u.daysSinceLastTrade + "d" : "—"}</td>
      <td class="dim text-xs">${formatDateShort(u.lastActive)}</td>
      <td><button class="btn btn-ghost btn-sm" data-quick-reset="${escapeAttr(u.id)}" title="Reset portfolio">⟲</button></td>
    </tr>`).join("");
}
function colHead(col, label) {
  const arrow = state.sort.by === col ? (state.sort.dir === "asc" ? " ↑" : " ↓") : "";
  return `<th data-col="${col}" class="sortable">${escapeHtml(label)}${arrow}</th>`;
}
function wireRowClicks(host, main) {
  host.querySelectorAll(".admin-table tbody tr").forEach(tr => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-quick-reset]")) return;
      openUserModal(tr.dataset.userId);
    });
  });
  host.querySelectorAll("[data-quick-reset]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const userId = btn.dataset.quickReset;
      const reason = prompt("Reason for reset (≥ 8 chars, logged to audit):");
      if (!reason || reason.trim().length < 8) return;
      adminPost("/api/ai?op=admin-user-reset", { userId, reason })
        .then(() => { toast({ kind: "success", message: "User reset." }); loadOverview().then(() => renderTabBody(main)); })
        .catch(e => toast({ kind: "error", message: e.message }));
    });
  });
  host.querySelectorAll("[data-open-user]").forEach(el => {
    el.addEventListener("click", (e) => { e.preventDefault(); openUserModal(el.dataset.openUser); });
  });
}

function applyFiltersAndSort(users) {
  const f = state.filters;
  let list = users;
  if (f.search) {
    const q = f.search.toLowerCase();
    list = list.filter(u =>
      (u.username || "").toLowerCase().includes(q) ||
      (u.displayName || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q) ||
      (u.school || "").toLowerCase().includes(q) ||
      (u.city || "").toLowerCase().includes(q));
  }
  if (f.onboarded !== "any")      list = list.filter(u => f.onboarded === "yes" ? !!u.onboarded : !u.onboarded);
  if (f.riskProfile !== "any")    list = list.filter(u => u.riskProfile === f.riskProfile);
  if (f.consent !== "any")        list = list.filter(u => f.consent === "yes" ? u.parentConsented : !u.parentConsented);
  if (f.traded !== "any")         list = list.filter(u => f.traded === "yes" ? u.tradeCount > 0 : u.tradeCount === 0);
  if (f.coached !== "any")        list = list.filter(u => f.coached === "yes" ? u.coachMsgCount > 0 : u.coachMsgCount === 0);
  if (f.ageBracket !== "any") {
    list = list.filter(u => {
      const a = u.age;
      if (a == null) return false;
      if (f.ageBracket === "13-15") return a >= 13 && a <= 15;
      if (f.ageBracket === "16-17") return a >= 16 && a <= 17;
      if (f.ageBracket === "18+")   return a >= 18;
      return true;
    });
  }
  if (f.tradeBucket !== "any") {
    list = list.filter(u => {
      const c = u.tradeCount;
      if (f.tradeBucket === "0")    return c === 0;
      if (f.tradeBucket === "1-5")  return c >= 1 && c <= 5;
      if (f.tradeBucket === "6-20") return c >= 6 && c <= 20;
      if (f.tradeBucket === "20+")  return c > 20;
      return true;
    });
  }
  if (f.activity !== "any") {
    const now = Date.now();
    list = list.filter(u => {
      const diff = u.lastActive ? now - new Date(u.lastActive).getTime() : Infinity;
      const days = diff / 86400000;
      if (f.activity === "<1d")   return days < 1;
      if (f.activity === "<7d")   return days < 7;
      if (f.activity === "<30d")  return days < 30;
      if (f.activity === "30d+")  return days >= 30;
      return true;
    });
  }
  if (f.school !== "any")         list = list.filter(u => u.school === f.school);
  const { by, dir } = state.sort;
  list = list.slice().sort((a, b) => {
    const av = a[by], bv = b[by];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av === bv) return 0;
    return (av > bv ? 1 : -1) * (dir === "asc" ? 1 : -1);
  });
  return list;
}

// -----------------------------------------------------------------------------
// User drill-down modal (14 sections)
// -----------------------------------------------------------------------------
async function openUserModal(userId) {
  const host = document.getElementById("modal-root");
  host.innerHTML = `
    <div class="modal-overlay" id="admin-user-overlay">
      <div class="modal" style="max-width: 880px; max-height: 90vh; overflow: auto;">
        <div class="modal-head">
          <h2>Loading…</h2>
          <button class="btn btn-ghost btn-icon" id="admin-close-modal">✕</button>
        </div>
        <div class="modal-body" id="admin-user-body"><div class="muted">Fetching 11 parallel queries…</div></div>
      </div>
    </div>`;
  document.getElementById("admin-close-modal").addEventListener("click", () => host.innerHTML = "");
  document.getElementById("admin-user-overlay").addEventListener("click", e => {
    if (e.target.id === "admin-user-overlay") host.innerHTML = "";
  });
  state.userDetailLoading = true;
  try {
    state.userDetail = await adminGet("/api/ai?op=admin-user&id=" + encodeURIComponent(userId));
  } catch (e) {
    state.userDetail = { error: e.message };
  }
  state.userDetailLoading = false;
  paintUserModal();
}
function paintUserModal() {
  const host = document.getElementById("modal-root");
  const body = document.getElementById("admin-user-body");
  const head = host?.querySelector(".modal-head h2");
  if (!body || !head) return;
  const d = state.userDetail;
  if (d?.error) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(d.error)}</div>`; head.textContent = "Error"; return; }
  const { profile, portfolio, holdings, transactions, coachMessages, portfolioHistory, watchlist, friends, transfers, limitOrders, adminActionHistory, reportCard, authMeta } = d;
  head.innerHTML = `${escapeHtml(profile.display_name || profile.username)} <span class="dim text-sm">@${escapeHtml(profile.username)}</span>`;

  const histValues = (portfolioHistory || []).map(h => (h.total_value_paise || 0) / 100);
  const histSvg = histValues.length > 1
    ? `<div style="height: 180px;">${areaChart(histValues, { height: 180, color: "var(--brand)", paddingLeft: 40 })}</div>`
    : `<div class="muted text-sm" style="padding: var(--sp-3); border: 1px dashed var(--border); border-radius: var(--r); text-align:center;">No history yet. Kick off backfill from System tab.</div>`;

  const totalHoldValue = (holdings || []).reduce((a, h) => a + (Number(h.qty) || 0) * (Number(h.avg_cost_paise) || 0), 0) / 100;
  const cashRupees = (portfolio?.cash_paise || 0) / 100;
  const totalValue = cashRupees + totalHoldValue;

  body.innerHTML = `
    <div class="admin-drill-nav">
      ${["identity","money","history","holdings","transactions","orders","watchlist","friends","transfers","coach","report","auth","audit","raw"].map(s => `<a href="#sec-${s}" class="drill-jump">${s}</a>`).join("")}
    </div>

    <div id="sec-identity"><div class="admin-user-section-label">1. Identity</div>
      <div class="admin-user-grid">
        <div>
          ${kv("Email", profile.email)}
          ${kv("Age", profile.age)}
          ${kv("School", profile.school)}
          ${kv("Class code", profile.class_code)}
          ${kv("City", profile.city)}
          ${kv("Risk profile", profile.risk_profile)}
          ${kv("Avatar color", profile.avatar_color)}
        </div>
        <div>
          ${kv("Parent email", profile.parent_email)}
          ${kv("Consent at", profile.parent_consent_at ? formatDateShort(profile.parent_consent_at) : "—")}
          ${kv("Onboarded", profile.onboarded ? "Yes" : "No")}
          ${kv("Joined", formatDateShort(profile.created_at))}
          ${kv("Updated", formatDateShort(profile.updated_at))}
          ${kv("ID", profile.id)}
        </div>
      </div>
    </div>

    <div id="sec-money"><div class="admin-user-section-label">2. Money</div>
      <div class="admin-kv"><span>Cash</span><span>${formatRupees(cashRupees * 100)}</span></div>
      <div class="admin-kv"><span>Holdings (cost-basis)</span><span>${formatRupees(totalHoldValue * 100)}</span></div>
      <div class="admin-kv"><span>Starting cash</span><span>${formatRupees(portfolio?.starting_cash_paise || 10000000)}</span></div>
      <div class="admin-kv" style="border-top:1px solid var(--divider); padding-top: 6px; margin-top: 6px;">
        <span class="font-semi">Total portfolio</span><span class="font-semi">${formatRupees(totalValue * 100)}</span>
      </div>
    </div>

    <div id="sec-history"><div class="admin-user-section-label">3. Portfolio value over time</div>${histSvg}</div>

    <div id="sec-holdings"><div class="admin-user-section-label">4. Holdings (${holdings?.length || 0})</div>
      ${holdings?.length ? `<table class="admin-table"><thead><tr><th>Symbol</th><th>Qty</th><th>Avg cost</th><th>Cost basis</th><th>First bought</th></tr></thead><tbody>
        ${holdings.map(h => `<tr><td>${escapeHtml(h.symbol)}</td><td class="tabular">${h.qty}</td><td class="tabular">${formatRupees(h.avg_cost_paise || 0)}</td><td class="tabular">${formatRupees((Number(h.qty) || 0) * (Number(h.avg_cost_paise) || 0))}</td><td class="dim text-xs">${formatDateShort(h.first_bought_at)}</td></tr>`).join("")}
      </tbody></table>` : `<div class="muted text-sm">No holdings.</div>`}</div>

    <div id="sec-transactions"><div class="admin-user-section-label">5. Transactions (last ${transactions?.length || 0})</div>
      ${transactions?.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Side</th><th>Symbol</th><th>Qty</th><th>Price</th><th>Value</th><th>Biases</th><th>Act</th></tr></thead><tbody>
        ${transactions.slice(0, 100).map(t => `<tr>
          <td class="dim text-xs">${formatDateShort(t.created_at)}</td>
          <td><span class="pill ${t.side === "BUY" ? "pill-green" : "pill-red"}" style="font-size:10px;">${t.side}</span></td>
          <td>${escapeHtml(t.symbol)}</td>
          <td class="tabular">${t.qty}</td>
          <td class="tabular">${formatRupees(t.price_paise || 0)}</td>
          <td class="tabular">${formatRupees(t.value_paise || 0)}</td>
          <td class="dim text-xs">${Array.isArray(t.bias_flags) ? t.bias_flags.length : 0}</td>
          <td><button class="btn btn-ghost btn-sm" data-delete-trade="${escapeAttr(t.id)}">reverse</button></td>
        </tr>`).join("")}
      </tbody></table>` : `<div class="muted text-sm">No trades.</div>`}</div>

    <div id="sec-orders"><div class="admin-user-section-label">6. Limit orders (${limitOrders?.length || 0})</div>
      ${limitOrders?.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Side</th><th>Symbol</th><th>Qty</th><th>Limit</th><th>Status</th><th>Act</th></tr></thead><tbody>
        ${limitOrders.map(o => `<tr>
          <td class="dim text-xs">${formatDateShort(o.created_at)}</td>
          <td>${o.side}</td><td>${escapeHtml(o.symbol)}</td><td class="tabular">${o.qty}</td>
          <td class="tabular">${formatRupees(o.limit_price_paise || 0)}</td>
          <td>${o.status}</td>
          <td>${o.status === "pending" ? `<button class="btn btn-ghost btn-sm" data-cancel-order="${escapeAttr(o.id)}">cancel</button>` : "—"}</td>
        </tr>`).join("")}
      </tbody></table>` : `<div class="muted text-sm">No orders.</div>`}</div>

    <div id="sec-watchlist"><div class="admin-user-section-label">7. Watchlist (${watchlist?.length || 0})</div>
      ${watchlist?.length ? `<div class="flex gap-1 wrap">${watchlist.map(w => `<span class="pill">${escapeHtml(w.symbol)}</span>`).join("")}</div>` : `<div class="muted text-sm">Empty.</div>`}</div>

    <div id="sec-friends"><div class="admin-user-section-label">8. Friends (${friends?.length || 0})</div>
      ${friends?.length ? `<div class="dim text-sm">${friends.length} friend(s) — IDs: ${friends.map(f => escapeHtml((f.friend_id || "").slice(0, 8))).join(", ")}</div>` : `<div class="muted text-sm">No friends yet.</div>`}</div>

    <div id="sec-transfers"><div class="admin-user-section-label">9. Transfers (${transfers?.length || 0})</div>
      ${transfers?.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Dir</th><th>Amount</th><th>Status</th><th>Act</th></tr></thead><tbody>
        ${transfers.map(tf => `<tr>
          <td class="dim text-xs">${formatDateShort(tf.created_at)}</td>
          <td>${tf.sender_id === profile.id ? "OUT" : "IN"}</td>
          <td class="tabular">${formatRupees(tf.amount_paise || 0)}</td>
          <td>${tf.status}</td>
          <td><button class="btn btn-ghost btn-sm" data-void-transfer="${escapeAttr(tf.id)}">void</button></td>
        </tr>`).join("")}
      </tbody></table>` : `<div class="muted text-sm">No transfers.</div>`}</div>

    <div id="sec-coach"><div class="admin-user-section-label">10. Coach messages (${coachMessages?.length || 0})</div>
      ${coachMessages?.length ? `<div class="flex-col gap-2">${coachMessages.slice(0, 50).map(m => `
        <details class="admin-coach-row">
          <summary><strong>${escapeHtml(m.event_type || "—")}</strong> · ${escapeHtml(m.trigger_symbol || "—")} · <span class="dim">${formatDateShort(m.created_at)}</span> · model=${escapeHtml(m.model || "—")}
          <button class="btn btn-ghost btn-sm" data-delete-coach="${escapeAttr(m.id)}" style="float:right;">delete</button></summary>
          <pre class="admin-coach-payload">${escapeHtml(JSON.stringify(m.payload || {}, null, 2))}</pre>
        </details>`).join("")}</div>` : `<div class="muted text-sm">No coach messages.</div>`}</div>

    <div id="sec-report"><div class="admin-user-section-label">11. Report card (server-computed)</div>
      ${reportCard ? `<div class="admin-user-grid">
        <div>
          ${kv("Total trades", reportCard.totalTrades)}
          ${kv("Closed trades", reportCard.closedTrades)}
          ${kv("Wins / Losses", reportCard.wins + " / " + reportCard.losses)}
          ${kv("Win rate", Math.round(reportCard.winRate * 100) + "%")}
        </div>
        <div>
          ${kv("Biggest win", formatRupees(reportCard.biggestWinRupees * 100))}
          ${kv("Biggest loss", formatRupees(reportCard.biggestLossRupees * 100))}
          ${kv("Avg hold days", reportCard.avgHoldDays)}
          ${kv("Bias flags", (reportCard.biasFlags || []).join(", ") || "—")}
        </div>
      </div>` : `<div class="muted text-sm">Not available.</div>`}</div>

    <div id="sec-auth"><div class="admin-user-section-label">12. Supabase Auth metadata</div>
      ${authMeta ? `<div class="admin-user-grid">
        <div>
          ${kv("Last sign-in", authMeta.lastSignInAt ? formatDateShort(authMeta.lastSignInAt) : "—")}
          ${kv("Email confirmed", authMeta.emailConfirmedAt ? formatDateShort(authMeta.emailConfirmedAt) : "—")}
          ${kv("Phone", authMeta.phone || "—")}
          ${kv("Banned until", authMeta.bannedUntil || "—")}
        </div>
        <div>
          ${kv("Created", formatDateShort(authMeta.createdAt))}
          ${kv("Updated", formatDateShort(authMeta.updatedAt))}
          <details><summary>Raw user metadata</summary><pre class="admin-coach-payload">${escapeHtml(JSON.stringify(authMeta.rawUserMetaData || {}, null, 2))}</pre></details>
        </div>
      </div>
      <div class="flex gap-2 wrap" style="margin-top: var(--sp-3);">
        <button class="btn btn-ghost btn-sm" data-auth-reset="${escapeAttr(profile.email)}">Send reset email</button>
        <button class="btn btn-ghost btn-sm" data-auth-magic="${escapeAttr(profile.email)}">Magic link</button>
        ${authMeta.bannedUntil ? `<button class="btn btn-ghost btn-sm" data-unban="${escapeAttr(profile.id)}">Unban</button>` : `<button class="btn btn-ghost btn-sm" data-ban="${escapeAttr(profile.id)}" style="color:var(--negative);">Ban</button>`}
        <button class="btn btn-ghost btn-sm" data-delete-user="${escapeAttr(profile.id)}" data-username="${escapeAttr(profile.username)}" style="color:var(--negative);">Delete account</button>
      </div>
      ` : `<div class="muted text-sm">Unreachable (service-role needed).</div>`}</div>

    <div id="sec-audit"><div class="admin-user-section-label">13. Admin action history (${adminActionHistory?.length || 0})</div>
      ${adminActionHistory?.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Action</th><th>Reason</th></tr></thead><tbody>
        ${adminActionHistory.map(a => `<tr><td class="dim text-xs">${formatDateShort(a.ts)}</td><td>${escapeHtml(a.action)}</td><td class="dim text-xs">${escapeHtml(a.reason || "—")}</td></tr>`).join("")}
      </tbody></table>` : `<div class="muted text-sm">None.</div>`}</div>

    <div id="sec-raw"><div class="admin-user-section-label">14. Raw (collapsed)</div>
      <details><summary>Expand every field as JSON</summary><pre class="admin-coach-payload">${escapeHtml(JSON.stringify(d, null, 2))}</pre></details>
    </div>
  `;
  wireModalActions(profile);
}
function wireModalActions(profile) {
  const host = document.getElementById("modal-root");
  host.querySelectorAll("[data-delete-trade]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason for reversing this trade (≥ 8 chars):");
    if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-trade-delete", { txnId: b.dataset.deleteTrade, reason }); toast({ kind: "success", message: "Trade reversed." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-cancel-order]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason for cancelling (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-order-cancel", { orderId: b.dataset.cancelOrder, reason }); toast({ kind: "success", message: "Cancelled." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-void-transfer]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason for voiding (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-transfer-void", { transferId: b.dataset.voidTransfer, reason }); toast({ kind: "success", message: "Voided." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-delete-coach]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-coach-delete", { messageId: b.dataset.deleteCoach, reason }); toast({ kind: "success", message: "Deleted." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-auth-reset]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-auth-reset", { email: b.dataset.authReset, reason }); toast({ kind: "success", message: "Reset email sent." }); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-auth-magic]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { const r = await adminPost("/api/ai?op=admin-auth-magiclink", { email: b.dataset.authMagic, reason }); toast({ kind: "success", message: "Link: " + (r.link || "generated.") }); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-ban]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason for ban (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-user-ban", { userId: b.dataset.ban, reason }); toast({ kind: "success", message: "Banned." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-unban]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-user-unban", { userId: b.dataset.unban, reason }); toast({ kind: "success", message: "Unbanned." }); openUserModal(profile.id); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-delete-user]").forEach(b => b.addEventListener("click", async () => {
    const username = b.dataset.username;
    const confirm = prompt(`DESTRUCTIVE. Type the username (${username}) to confirm:`);
    if (confirm !== username) return;
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-user-delete", { userId: b.dataset.deleteUser, confirm: username, reason }); toast({ kind: "success", message: "Deleted." }); document.getElementById("modal-root").innerHTML = ""; } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
}

// -----------------------------------------------------------------------------
// Activity tab + Live tail (SSE)
// -----------------------------------------------------------------------------
function renderActivityTab(host, main) {
  host.innerHTML = `
    <div class="card" style="margin-bottom: var(--sp-3);">
      <div class="card-head">
        <h3>Live activity feed</h3>
        <div class="flex gap-2 items-center">
          <select id="act-filter" class="select">
            <option value="all">All events</option>
            <option value="trades">Trades</option>
            <option value="coach">Coach</option>
            <option value="transfers">Transfers</option>
            <option value="orders">Orders</option>
            <option value="signups">Signups</option>
          </select>
          <button class="btn btn-ghost btn-sm" id="act-clear">Clear</button>
        </div>
      </div>
      <div id="activity-list" class="activity-list">
        <div class="muted text-sm" style="padding: var(--sp-3);">Open Live tail at the top to start streaming events.</div>
      </div>
    </div>`;
  host.querySelector("#act-filter").addEventListener("change", e => {
    state.activityFilter = e.target.value;
    repaintActivity();
  });
  host.querySelector("#act-clear").addEventListener("click", () => {
    state.activity = [];
    repaintActivity();
  });
  // Also auto-fetch a recent batch of events so the feed isn't empty on open.
  adminGet("/api/ai?op=admin-activity-feed&limit=100")
    .then(d => { state.activity = (d?.events || []).reverse(); repaintActivity(); })
    .catch(() => {});
}

function repaintActivity() {
  const host = document.getElementById("activity-list");
  if (!host) return;
  const events = state.activity
    .filter(e => state.activityFilter === "all" || matchesFilter(e.kind, state.activityFilter))
    .slice(-500);
  if (!events.length) {
    host.innerHTML = `<div class="muted text-sm" style="padding: var(--sp-3);">No events yet.</div>`;
    return;
  }
  host.innerHTML = events.slice().reverse().map(e => renderEventRow(e)).join("");
}
function matchesFilter(kind, filter) {
  if (filter === "trades")    return kind === "trade";
  if (filter === "coach")     return kind === "coach";
  if (filter === "transfers") return kind === "transfer";
  if (filter === "orders")    return kind === "order";
  if (filter === "signups")   return kind === "signup";
  return true;
}
function renderEventRow(ev) {
  const icon = ({ trade: "🟢", coach: "💬", transfer: "💸", order: "📊", signup: "✨", admin: "🛠" })[ev.kind] || "•";
  const payload = ev.payload?.row || ev.payload || {};
  let summary = "";
  if (ev.kind === "trade")    summary = `${payload.side} ${payload.qty} ${payload.symbol} @ ${formatRupees(payload.price_paise || 0, { compact: true })}`;
  else if (ev.kind === "coach") summary = `${payload.event_type || ""} ${payload.trigger_symbol || ""}`;
  else if (ev.kind === "transfer") summary = `${formatRupees(payload.amount_paise || 0, { compact: true })} (${payload.status})`;
  else if (ev.kind === "order")    summary = `${payload.side} ${payload.qty} ${payload.symbol} — ${payload.status}`;
  else if (ev.kind === "signup")   summary = `@${payload.username || (payload.id || "").slice(0, 8)}`;
  else if (ev.kind === "admin")    summary = `${payload.action} · ${payload.reason || ""}`;
  return `<div class="activity-row"><span class="act-icon">${icon}</span><span class="act-kind">${escapeHtml(ev.kind)}</span><span class="act-summary">${escapeHtml(summary)}</span><span class="act-ts dim">${formatDateShort(ev.ts)}</span></div>`;
}

function openTail(main) {
  if (state.tail) return;
  const token = getToken();
  if (!token) { toast({ kind: "error", message: "No admin token." }); return; }
  const url = `/api/ai?op=admin-tail&token=${encodeURIComponent(token)}`;
  const es = new EventSource(url);
  state.tail = es;
  es.addEventListener("open", () => { state.tailConnected = true; updateTailBadge(main); });
  es.addEventListener("error", () => { state.tailConnected = false; updateTailBadge(main); });
  ["trade", "coach", "transfer", "order", "signup", "admin"].forEach(kind => {
    es.addEventListener(kind, (e) => {
      try {
        const ev = JSON.parse(e.data);
        state.activity.push(ev);
        if (state.activity.length > 500) state.activity.shift();
        if (currentTab === "activity") repaintActivity();
      } catch {}
    });
  });
  es.addEventListener("close", () => { state.tailConnected = false; state.tail = null; updateTailBadge(main); });
}
function closeTail() {
  if (state.tail) { try { state.tail.close(); } catch {} state.tail = null; }
  state.tailConnected = false;
}
function updateTailBadge(main) {
  const el = main.querySelector("#tail-indicator");
  const btn = main.querySelector("#tail-toggle");
  if (el) { el.className = `tail-indicator ${state.tailConnected ? "live" : "off"}`; el.textContent = state.tailConnected ? "● LIVE" : "○ paused"; }
  if (btn) btn.textContent = state.tailConnected ? "Pause tail" : "Live tail";
}

// -----------------------------------------------------------------------------
// Database tab — SQL editor, table browser, RPC runner, schema, stats
// -----------------------------------------------------------------------------
const dbState = {
  tables: null, schema: null, stats: null,
  browseTable: null, browseRows: [], browseTotal: 0, browseOffset: 0, browseLimit: 50, browseOrderBy: "", browseOrderDir: "desc", browseFilter: "",
  sqlInput: "select * from profiles limit 10;",
  sqlResult: null, sqlRunning: false,
  rpcName: "", rpcParams: "{}", rpcResult: null,
  view: "browser",  // browser | sql | rpc | schema | stats
};
function renderDatabaseTab(host, main) {
  host.innerHTML = `
    <div class="card" style="margin-bottom: var(--sp-3);">
      <div class="card-head">
        <h3>Supabase god mode</h3>
        <div class="flex gap-2">
          ${["browser","sql","rpc","schema","stats"].map(v => `<button class="btn btn-ghost btn-sm ${dbState.view === v ? "active-btn" : ""}" data-db-view="${v}">${v}</button>`).join("")}
        </div>
      </div>
      <div id="db-view-body"></div>
    </div>`;
  host.querySelectorAll("[data-db-view]").forEach(b => b.addEventListener("click", () => {
    dbState.view = b.dataset.dbView;
    renderDatabaseTab(host, main);
  }));
  renderDbView(host);
}
async function renderDbView(host) {
  const body = host.querySelector("#db-view-body");
  if (!body) return;
  if (dbState.view === "browser") return renderDbBrowser(body);
  if (dbState.view === "sql") return renderDbSql(body);
  if (dbState.view === "rpc") return renderDbRpc(body);
  if (dbState.view === "schema") return renderDbSchema(body);
  if (dbState.view === "stats") return renderDbStats(body);
}

async function renderDbBrowser(body) {
  body.innerHTML = `<div class="muted">Loading table list…</div>`;
  if (!dbState.tables) {
    try { dbState.tables = (await adminGet("/api/ai?op=admin-db-tables")).tables || []; }
    catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; return; }
  }
  const t = dbState.browseTable;
  body.innerHTML = `
    <div class="flex gap-2 wrap" style="margin-bottom: var(--sp-3);">
      <select class="select" id="db-table-picker" style="max-width: 280px;">
        <option value="">-- pick a table --</option>
        ${dbState.tables.map(x => `<option value="${escapeAttr(x.table_name)}" ${t === x.table_name ? "selected" : ""}>${escapeHtml(x.table_name)} (${x.approx_row_count} rows · ${x.total_size})</option>`).join("")}
      </select>
      ${t ? `
        <input class="input" id="db-order" placeholder="order by col" value="${escapeAttr(dbState.browseOrderBy)}" style="max-width: 140px;" />
        <select class="select" id="db-order-dir" style="max-width: 80px;">
          <option value="desc" ${dbState.browseOrderDir === "desc" ? "selected" : ""}>desc</option>
          <option value="asc" ${dbState.browseOrderDir === "asc" ? "selected" : ""}>asc</option>
        </select>
        <input class="input" id="db-filter" placeholder="filter (e.g. age=gte.13)" value="${escapeAttr(dbState.browseFilter)}" style="flex:1;" />
        <button class="btn btn-primary btn-sm" id="db-browse-go">Apply</button>
      ` : ""}
    </div>
    <div id="db-browse-result"></div>`;
  body.querySelector("#db-table-picker").addEventListener("change", (e) => {
    dbState.browseTable = e.target.value || null;
    dbState.browseOffset = 0;
    renderDbBrowser(body);
    if (dbState.browseTable) fetchBrowserRows(body);
  });
  body.querySelector("#db-order")?.addEventListener("change", e => { dbState.browseOrderBy = e.target.value; });
  body.querySelector("#db-order-dir")?.addEventListener("change", e => { dbState.browseOrderDir = e.target.value; });
  body.querySelector("#db-filter")?.addEventListener("change", e => { dbState.browseFilter = e.target.value; });
  body.querySelector("#db-browse-go")?.addEventListener("click", () => fetchBrowserRows(body));
  if (t && dbState.browseRows.length === 0) fetchBrowserRows(body);
  else if (t) paintBrowserRows(body);
}
async function fetchBrowserRows(body) {
  const resultHost = body.querySelector("#db-browse-result");
  resultHost.innerHTML = `<div class="muted">Loading rows…</div>`;
  try {
    const q = new URLSearchParams({
      op: "admin-db-browse",
      table: dbState.browseTable,
      limit: dbState.browseLimit,
      offset: dbState.browseOffset,
    });
    if (dbState.browseOrderBy) { q.set("orderBy", dbState.browseOrderBy); q.set("orderDir", dbState.browseOrderDir); }
    if (dbState.browseFilter) q.set("filter", dbState.browseFilter);
    const r = await adminGet("/api/ai?" + q);
    dbState.browseRows = r.rows || [];
    dbState.browseTotal = r.total || 0;
    paintBrowserRows(body);
  } catch (e) {
    resultHost.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`;
  }
}
function paintBrowserRows(body) {
  const host = body.querySelector("#db-browse-result");
  if (!host) return;
  if (!dbState.browseRows.length) {
    host.innerHTML = `<div class="muted text-sm">Empty result.</div>`; return;
  }
  const cols = Object.keys(dbState.browseRows[0]);
  host.innerHTML = `
    <div class="dim text-xs" style="margin-bottom: 6px;">
      Showing ${dbState.browseOffset + 1}–${dbState.browseOffset + dbState.browseRows.length} of ${dbState.browseTotal}
      <button class="btn btn-ghost btn-sm" data-browse-prev ${dbState.browseOffset === 0 ? "disabled" : ""}>← prev</button>
      <button class="btn btn-ghost btn-sm" data-browse-next ${dbState.browseOffset + dbState.browseLimit >= dbState.browseTotal ? "disabled" : ""}>next →</button>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}<th></th></tr></thead>
        <tbody>
          ${dbState.browseRows.map((row, i) => `<tr>
            ${cols.map(c => `<td class="dim text-xs" style="max-width: 240px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(typeof row[c] === "object" ? JSON.stringify(row[c]).slice(0, 80) : String(row[c] ?? ""))}</td>`).join("")}
            <td><button class="btn btn-ghost btn-sm" data-edit-row="${i}">edit</button>
                <button class="btn btn-ghost btn-sm" data-delete-row="${i}" style="color:var(--negative);">del</button></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  host.querySelector("[data-browse-prev]")?.addEventListener("click", () => {
    dbState.browseOffset = Math.max(0, dbState.browseOffset - dbState.browseLimit);
    fetchBrowserRows(body);
  });
  host.querySelector("[data-browse-next]")?.addEventListener("click", () => {
    dbState.browseOffset = dbState.browseOffset + dbState.browseLimit;
    fetchBrowserRows(body);
  });
  host.querySelectorAll("[data-edit-row]").forEach(b => b.addEventListener("click", async () => {
    const idx = parseInt(b.dataset.editRow, 10);
    const row = dbState.browseRows[idx];
    const pkCol = row.id ? "id" : Object.keys(row)[0];
    const pkVal = row[pkCol];
    const col = prompt("Column to edit:");
    if (!col) return;
    const newVal = prompt(`New value for ${col} (current: ${row[col]}):`);
    if (newVal == null) return;
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try {
      await adminPost("/api/ai?op=admin-db-row-patch", {
        table: dbState.browseTable, filter: `${pkCol}=eq.${encodeURIComponent(pkVal)}`, patch: { [col]: newVal }, reason,
      });
      toast({ kind: "success", message: "Row updated." });
      fetchBrowserRows(body);
    } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-delete-row]").forEach(b => b.addEventListener("click", async () => {
    const idx = parseInt(b.dataset.deleteRow, 10);
    const row = dbState.browseRows[idx];
    const pkCol = row.id ? "id" : Object.keys(row)[0];
    const pkVal = row[pkCol];
    if (!confirm(`Delete row where ${pkCol}=${pkVal}?`)) return;
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try {
      await adminPost("/api/ai?op=admin-db-row-delete", {
        table: dbState.browseTable, filter: `${pkCol}=eq.${encodeURIComponent(pkVal)}`, reason,
      });
      toast({ kind: "success", message: "Row deleted." });
      fetchBrowserRows(body);
    } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
}

function renderDbSql(body) {
  body.innerHTML = `
    <div class="db-sql-warn">⚠ Raw SQL via admin_exec_sql RPC. Mutations are audited. Triple-check before running DDL.</div>
    <textarea class="input db-sql-input" id="db-sql-input" rows="8">${escapeHtml(dbState.sqlInput)}</textarea>
    <div class="flex gap-2" style="margin: var(--sp-3) 0;">
      <button class="btn btn-primary" id="db-sql-run">Execute</button>
      <input class="input" id="db-sql-reason" placeholder="Reason (≥ 8 chars, audit-logged)" style="flex:1;" />
    </div>
    <div id="db-sql-result"></div>`;
  body.querySelector("#db-sql-input").addEventListener("input", e => { dbState.sqlInput = e.target.value; });
  body.querySelector("#db-sql-run").addEventListener("click", async () => {
    const sql = dbState.sqlInput.trim();
    const reason = body.querySelector("#db-sql-reason").value.trim();
    if (!sql) return;
    if (reason.length < 8) { toast({ kind: "error", message: "Reason must be ≥ 8 chars." }); return; }
    // DDL confirmation
    const isDDL = /^\s*(drop|alter|create|truncate|grant|revoke)\s/i.test(sql);
    if (isDDL) {
      const ok = prompt("This looks like DDL. Type 'I understand RLS' to proceed:");
      if (ok !== "I understand RLS") return;
    }
    dbState.sqlRunning = true;
    body.querySelector("#db-sql-result").innerHTML = `<div class="muted">Running…</div>`;
    try {
      const r = await adminPost("/api/ai?op=admin-db-sql", { sql, reason });
      dbState.sqlResult = r;
      paintSqlResult(body);
    } catch (e) {
      body.querySelector("#db-sql-result").innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`;
    } finally { dbState.sqlRunning = false; }
  });
  if (dbState.sqlResult) paintSqlResult(body);
}
function paintSqlResult(body) {
  const host = body.querySelector("#db-sql-result");
  if (!host || !dbState.sqlResult) return;
  const r = dbState.sqlResult;
  if (r.error) { host.innerHTML = `<div style="color:var(--negative);">Error: ${escapeHtml(r.error)} ${r.sqlstate ? `(${r.sqlstate})` : ""}</div>`; return; }
  const rows = r.rows || [];
  if (!rows.length) { host.innerHTML = `<div class="muted">0 rows.</div>`; return; }
  const cols = Object.keys(rows[0]);
  host.innerHTML = `
    <div class="dim text-xs">${rows.length} rows</div>
    <div class="admin-table-wrap">
      <table class="admin-table"><thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(row => `<tr>${cols.map(c => `<td class="dim text-xs">${escapeHtml(typeof row[c] === "object" ? JSON.stringify(row[c]).slice(0, 100) : String(row[c] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody></table>
    </div>`;
}

function renderDbRpc(body) {
  body.innerHTML = `
    <div style="margin-bottom: var(--sp-3);">
      <input class="input" id="rpc-name" placeholder="RPC name (e.g. leaderboard)" value="${escapeAttr(dbState.rpcName)}" style="width: 300px;" />
      <textarea class="input" id="rpc-params" placeholder='{ "p_limit": 10 }' rows="4" style="width: 100%; margin-top: 8px;">${escapeHtml(dbState.rpcParams)}</textarea>
      <input class="input" id="rpc-reason" placeholder="Reason (≥ 8 chars)" style="margin-top: 8px;" />
      <button class="btn btn-primary" id="rpc-run" style="margin-top: 8px;">Invoke</button>
    </div>
    <div id="rpc-result"></div>`;
  body.querySelector("#rpc-run").addEventListener("click", async () => {
    const rpcName = body.querySelector("#rpc-name").value.trim();
    const params = body.querySelector("#rpc-params").value.trim();
    const reason = body.querySelector("#rpc-reason").value.trim();
    if (!rpcName) return;
    if (reason.length < 8) { toast({ kind: "error", message: "Reason ≥ 8 chars." }); return; }
    let parsedParams = {};
    try { parsedParams = params ? JSON.parse(params) : {}; } catch { toast({ kind: "error", message: "Params must be valid JSON." }); return; }
    try {
      const r = await adminPost("/api/ai?op=admin-db-rpc", { rpcName, params: parsedParams, reason });
      dbState.rpcResult = r;
      body.querySelector("#rpc-result").innerHTML = `<pre class="admin-coach-payload">${escapeHtml(JSON.stringify(r.result, null, 2))}</pre>`;
    } catch (e) {
      body.querySelector("#rpc-result").innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`;
    }
  });
}

async function renderDbSchema(body) {
  body.innerHTML = `<div class="muted">Loading schema…</div>`;
  try { dbState.schema = dbState.schema || await adminGet("/api/ai?op=admin-db-schema"); }
  catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; return; }
  const s = dbState.schema;
  body.innerHTML = `
    <div class="admin-user-grid">
      <div>
        <div class="admin-user-section-label">Columns (${s.columns.length})</div>
        ${renderList(s.columns, c => `<div class="dim text-xs"><strong>${escapeHtml(c.table_name)}.${escapeHtml(c.column_name)}</strong> · ${escapeHtml(c.data_type)} ${c.is_nullable === "YES" ? "·null ok" : ""}</div>`)}
      </div>
      <div>
        <div class="admin-user-section-label">Policies (${s.policies.length})</div>
        ${renderList(s.policies, p => `<div class="dim text-xs"><strong>${escapeHtml(p.tablename)}.${escapeHtml(p.policyname)}</strong> · ${escapeHtml(p.cmd)}</div>`)}
      </div>
      <div>
        <div class="admin-user-section-label">Indexes (${s.indexes.length})</div>
        ${renderList(s.indexes, i => `<div class="dim text-xs"><strong>${escapeHtml(i.indexname)}</strong> on ${escapeHtml(i.tablename)}</div>`)}
      </div>
      <div>
        <div class="admin-user-section-label">Functions (${s.functions.length})</div>
        ${renderList(s.functions, f => `<div class="dim text-xs"><strong>${escapeHtml(f.routine_name)}</strong> → ${escapeHtml(f.return_type)}</div>`)}
      </div>
    </div>`;
}
function renderList(items, fmt) { return items.length ? `<div class="flex-col gap-1" style="max-height: 300px; overflow: auto; padding: 8px; background: var(--bg-soft); border-radius: 4px;">${items.map(fmt).join("")}</div>` : `<div class="muted text-sm">None.</div>`; }

async function renderDbStats(body) {
  body.innerHTML = `<div class="muted">Loading DB stats…</div>`;
  try { dbState.stats = dbState.stats || await adminGet("/api/ai?op=admin-db-stats"); }
  catch (e) { body.innerHTML = `<div style="color:var(--negative);">${escapeHtml(e.message)}</div>`; return; }
  const s = dbState.stats;
  body.innerHTML = `
    <div class="admin-user-grid">
      <div>
        <div class="admin-user-section-label">Database size</div>
        <div class="admin-kv"><span>Size</span><span>${escapeHtml(s.size?.size || "—")}</span></div>
        <div class="admin-kv"><span>Bytes</span><span class="tabular">${s.size?.bytes ?? "—"}</span></div>
      </div>
      <div>
        <div class="admin-user-section-label">Connections by state</div>
        ${s.connections.map(c => `<div class="admin-kv"><span>${escapeHtml(c.state || "idle")}</span><span class="tabular">${c.count}</span></div>`).join("") || `<div class="muted text-sm">None.</div>`}
      </div>
      <div>
        <div class="admin-user-section-label">Cache hit ratio</div>
        <div class="admin-kv"><span>Hit ratio</span><span>${s.cacheHitRatio?.hit_ratio ? (s.cacheHitRatio.hit_ratio * 100).toFixed(2) + "%" : "—"}</span></div>
        <div class="admin-kv"><span>Hits</span><span class="tabular">${s.cacheHitRatio?.hits ?? "—"}</span></div>
        <div class="admin-kv"><span>Reads</span><span class="tabular">${s.cacheHitRatio?.reads ?? "—"}</span></div>
      </div>
    </div>`;
}

// -----------------------------------------------------------------------------
// Auth tab — Supabase Auth users admin
// -----------------------------------------------------------------------------
const authState = { users: null, loading: false };
async function renderAuthTab(host, main) {
  if (!authState.users && !authState.loading) {
    authState.loading = true;
    try { authState.users = (await adminGet("/api/ai?op=admin-auth-users&perPage=500")).users || []; }
    catch (e) { host.innerHTML = `<div class="card"><div style="color:var(--negative);">${escapeHtml(e.message)}</div></div>`; return; }
    finally { authState.loading = false; }
  }
  host.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>Supabase Auth users (${authState.users?.length || 0})</h3>
        <button class="btn btn-ghost btn-sm" id="auth-refresh">↻ Refresh</button>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr><th>Email</th><th>Last sign-in</th><th>Confirmed</th><th>Banned</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
            ${(authState.users || []).slice(0, 500).map(u => `<tr>
              <td><div class="font-semi">${escapeHtml(u.email || "—")}</div>
                  <div class="dim text-xs">${escapeHtml((u.id || "").slice(0, 8))}</div></td>
              <td class="dim text-xs">${u.lastSignInAt ? formatDateShort(u.lastSignInAt) : "—"}</td>
              <td>${u.emailConfirmedAt ? '<span class="pill pill-green" style="font-size:10px;">yes</span>' : '<span class="pill" style="font-size:10px;background:var(--bg-subtle);color:var(--text-dim);">no</span>'}</td>
              <td>${u.bannedUntil ? '<span class="pill pill-red" style="font-size:10px;">banned</span>' : "—"}</td>
              <td class="dim text-xs">${formatDateShort(u.createdAt)}</td>
              <td>
                <button class="btn btn-ghost btn-sm" data-auth-reset-email="${escapeAttr(u.email)}">reset pw</button>
                <button class="btn btn-ghost btn-sm" data-auth-magic-email="${escapeAttr(u.email)}">magic</button>
                ${!u.emailConfirmedAt ? `<button class="btn btn-ghost btn-sm" data-force-confirm="${escapeAttr(u.id)}">confirm</button>` : ""}
                ${u.bannedUntil ? `<button class="btn btn-ghost btn-sm" data-unban-user="${escapeAttr(u.id)}">unban</button>` : `<button class="btn btn-ghost btn-sm" data-ban-user="${escapeAttr(u.id)}" style="color:var(--negative);">ban</button>`}
              </td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
  host.querySelector("#auth-refresh").addEventListener("click", () => { authState.users = null; renderTabBody(main); });
  host.querySelectorAll("[data-auth-reset-email]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-auth-reset", { email: b.dataset.authResetEmail, reason }); toast({ kind: "success", message: "Sent." }); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-auth-magic-email]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { const r = await adminPost("/api/ai?op=admin-auth-magiclink", { email: b.dataset.authMagicEmail, reason }); toast({ kind: "success", message: "Link: " + (r.link || "sent.") }); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-force-confirm]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-auth-force-confirm", { userId: b.dataset.forceConfirm, reason }); toast({ kind: "success", message: "Confirmed." }); authState.users = null; renderTabBody(main); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-ban-user]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-user-ban", { userId: b.dataset.banUser, reason }); toast({ kind: "success", message: "Banned." }); authState.users = null; renderTabBody(main); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
  host.querySelectorAll("[data-unban-user]").forEach(b => b.addEventListener("click", async () => {
    const reason = prompt("Reason (≥ 8 chars):"); if (!reason || reason.trim().length < 8) return;
    try { await adminPost("/api/ai?op=admin-user-unban", { userId: b.dataset.unbanUser, reason }); toast({ kind: "success", message: "Unbanned." }); authState.users = null; renderTabBody(main); } catch (e) { toast({ kind: "error", message: e.message }); }
  }));
}

// -----------------------------------------------------------------------------
// Utility renderers
// -----------------------------------------------------------------------------
function kv(k, v) { return `<div class="admin-kv"><span>${escapeHtml(k)}</span><span>${escapeHtml(v ?? "—")}</span></div>`; }
function formatDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return Math.floor(diff / 60_000) + "m";
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + "h";
  if (diff < 7 * 86400_000) return Math.floor(diff / 86400_000) + "d";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
