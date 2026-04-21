// =============================================================================
// ADMIN PANEL — Owner-only dashboard. Gated by an ADMIN_TOKEN env var set
// on Vercel + pasted once into this page. Token is stored in localStorage
// and sent as Authorization: Bearer <token> on every admin API call.
//
// Shows:
//   - Aggregate stats (users, onboarded %, active, total cash, total trades)
//   - 30-day sign-up chart
//   - Searchable / sortable user table
//   - Click a user → drill-down modal: profile, holdings, transactions,
//     coach messages, portfolio-value graph
// =============================================================================

import { formatRupees } from "../money.js";
import { areaChart } from "../components/charts.js";
import { toast } from "../components/toast.js";

const TOKEN_KEY = "ss.adminToken.v1";

let overview = null;
let overviewLoading = false;
let overviewError = null;
let userDetail = null;     // currently-open user drill-down
let userDetailLoading = false;

let sortBy = "createdAt";
let sortDir = "desc";       // "desc" | "asc"
let search = "";

export function renderAdmin(main) {
  let cancelled = false;
  const onLeave = () => { cancelled = true; };
  window.addEventListener("hashchange", onLeave, { once: true });

  const token = getToken();
  if (!token) {
    renderTokenForm(main);
    return;
  }

  if (!overview && !overviewLoading) {
    loadOverview().then(() => { if (!cancelled) render(main); });
  }
  render(main);
}

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; }
  catch { return ""; }
}
function setToken(t) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
  catch {}
}

async function adminFetch(path) {
  const token = getToken();
  const r = await fetch(path, { headers: { "Authorization": "Bearer " + token } });
  if (r.status === 401) {
    setToken("");
    throw new Error("Unauthorised — check token and try again.");
  }
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function loadOverview() {
  overviewLoading = true;
  overviewError = null;
  try {
    overview = await adminFetch("/api/ai?op=admin-overview");
  } catch (e) {
    overviewError = e.message || String(e);
  } finally {
    overviewLoading = false;
  }
}

async function loadUser(id) {
  userDetailLoading = true;
  userDetail = { id };
  try {
    userDetail = await adminFetch("/api/ai?op=admin-user&id=" + encodeURIComponent(id));
  } catch (e) {
    userDetail = { id, error: e.message || String(e) };
  } finally {
    userDetailLoading = false;
  }
}

function renderTokenForm(main) {
  main.innerHTML = `
    <div style="max-width: 520px; margin: 10vh auto;">
      <div class="card">
        <h2 style="margin-top: 0;">Admin access</h2>
        <p class="muted" style="line-height: 1.6;">
          Paste the ADMIN_TOKEN you set on Vercel. Stored in localStorage on this
          device only; sent as a Bearer header on admin API calls.
        </p>
        <div class="field">
          <label class="label" for="admin-token">ADMIN_TOKEN</label>
          <input class="input" id="admin-token" type="password" autocomplete="off" placeholder="Paste token here" />
        </div>
        <div class="flex gap-2" style="margin-top: var(--sp-3);">
          <button id="admin-token-save" class="btn btn-primary">Unlock</button>
          <a href="#/" class="btn btn-ghost">Cancel</a>
        </div>
        <p class="dim text-xs" style="margin-top: var(--sp-4); line-height: 1.6;">
          Set ADMIN_TOKEN in Vercel → Settings → Environment Variables, any
          random string (e.g. openssl rand -hex 24). Restart the deployment
          or wait for the next cold start for the env var to apply.
        </p>
      </div>
    </div>
  `;
  const input = main.querySelector("#admin-token");
  input.focus();
  const submit = () => {
    const t = input.value.trim();
    if (!t) return;
    setToken(t);
    loadOverview().then(() => {
      if (!overview) {
        setToken("");
        toast({ kind: "error", message: overviewError || "Token rejected." });
        renderAdmin(main);
        return;
      }
      renderAdmin(main);
    });
  };
  main.querySelector("#admin-token-save").addEventListener("click", submit);
  input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
}

function render(main) {
  if (overviewLoading && !overview) {
    main.innerHTML = `<div class="card" style="text-align:center; padding: var(--sp-6);"><div class="muted">Loading admin overview…</div></div>`;
    return;
  }
  if (overviewError && !overview) {
    main.innerHTML = `<div class="card"><h3 style="color: var(--negative);">Admin error</h3><p class="muted">${escapeHtml(overviewError)}</p><button class="btn btn-ghost" id="logout">Clear token</button></div>`;
    main.querySelector("#logout")?.addEventListener("click", () => { setToken(""); renderAdmin(main); });
    return;
  }
  if (!overview) { renderTokenForm(main); return; }

  const { aggregates: a, byDay, users } = overview;
  const filteredUsers = filterAndSort(users, search, sortBy, sortDir);
  const chartValues = byDay.map(d => d.count);
  const chartSvg = areaChart(chartValues, { height: 80, color: "var(--brand)", paddingLeft: 0 });
  const maxDay = byDay.reduce((a, b) => b.count > a.count ? b : a, { count: 0, day: "" });

  main.innerHTML = `
    <div class="flex items-center justify-between wrap gap-3" style="margin-bottom: var(--sp-5);">
      <div>
        <h1 style="margin-bottom: 4px;">Admin</h1>
        <p class="muted">Every user, every trade, every rupee. Refreshed on load.</p>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-ghost btn-sm" id="admin-refresh">↻ Refresh</button>
        <button class="btn btn-ghost btn-sm" id="admin-logout">Sign out</button>
      </div>
    </div>

    <div class="admin-stats">
      <div class="stat-tile"><div class="l">Users</div><div class="v tabular">${a.users}</div></div>
      <div class="stat-tile"><div class="l">Onboarded</div><div class="v tabular">${a.onboarded} <span class="dim text-sm">(${a.onboardedPct}%)</span></div></div>
      <div class="stat-tile"><div class="l">Traded ever</div><div class="v tabular">${a.active}</div></div>
      <div class="stat-tile"><div class="l">Total cash</div><div class="v tabular">${formatRupees(a.totalCashRupees * 100, { compact: true })}</div></div>
      <div class="stat-tile"><div class="l">Total trades</div><div class="v tabular">${a.totalTrades}</div></div>
      <div class="stat-tile"><div class="l">Coach msgs</div><div class="v tabular">${a.totalCoachMessages}</div></div>
    </div>

    <div class="card" style="margin-top: var(--sp-4);">
      <div class="card-head">
        <h3>Sign-ups · last 30 days</h3>
        <span class="dim text-sm">Peak: ${maxDay.count || 0} on ${escapeHtml(maxDay.day || "—")}</span>
      </div>
      <div style="height: 80px;">${chartSvg}</div>
      <div class="admin-day-bars">
        ${byDay.slice(-14).map(d => `<div class="admin-day-bar" title="${d.day}: ${d.count}"><div class="bar" style="height: ${Math.max(2, d.count * 6)}px;"></div><div class="label">${d.day.slice(5)}</div></div>`).join("")}
      </div>
    </div>

    <div class="card" style="margin-top: var(--sp-4);">
      <div class="card-head">
        <h3>Users (${users.length})</h3>
        <input id="admin-search" class="input" placeholder="Search by username / name / email / school" value="${escapeAttr(search)}" style="max-width: 360px;" />
      </div>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              ${colHead("username", "User")}
              ${colHead("createdAt", "Joined")}
              ${colHead("onboarded", "OB")}
              ${colHead("age", "Age")}
              ${colHead("city", "City")}
              ${colHead("tradeCount", "Trades")}
              ${colHead("cashRupees", "Cash")}
              ${colHead("lastActive", "Last active")}
            </tr>
          </thead>
          <tbody>
            ${filteredUsers.map(u => `
              <tr data-user-id="${escapeAttr(u.id)}">
                <td>
                  <div class="font-semi">${escapeHtml(u.displayName || u.username)}</div>
                  <div class="dim text-xs">@${escapeHtml(u.username || "")} · ${escapeHtml(u.email || "")}</div>
                </td>
                <td class="dim text-xs">${formatDateShort(u.createdAt)}</td>
                <td>${u.onboarded ? '<span class="pill pill-green" style="font-size:10px;">OB</span>' : '<span class="pill" style="font-size:10px;background:var(--bg-subtle);color:var(--text-dim);">NEW</span>'}</td>
                <td class="dim">${u.age ?? "—"}</td>
                <td class="dim">${escapeHtml(u.city || "—")}</td>
                <td class="tabular">${u.tradeCount}</td>
                <td class="tabular">${u.cashRupees != null ? formatRupees(u.cashRupees * 100, { compact: true }) : "—"}</td>
                <td class="dim text-xs">${formatDateShort(u.lastActive)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;

  main.querySelector("#admin-refresh")?.addEventListener("click", async () => {
    await loadOverview();
    render(main);
  });
  main.querySelector("#admin-logout")?.addEventListener("click", () => {
    setToken("");
    overview = null;
    renderAdmin(main);
  });
  main.querySelector("#admin-search")?.addEventListener("input", (e) => {
    search = e.target.value;
    // Re-render table body only to preserve focus
    const tbody = main.querySelector(".admin-table tbody");
    if (tbody) {
      const list = filterAndSort(users, search, sortBy, sortDir);
      tbody.innerHTML = list.map(u => `
        <tr data-user-id="${escapeAttr(u.id)}">
          <td>
            <div class="font-semi">${escapeHtml(u.displayName || u.username)}</div>
            <div class="dim text-xs">@${escapeHtml(u.username || "")} · ${escapeHtml(u.email || "")}</div>
          </td>
          <td class="dim text-xs">${formatDateShort(u.createdAt)}</td>
          <td>${u.onboarded ? '<span class="pill pill-green" style="font-size:10px;">OB</span>' : '<span class="pill" style="font-size:10px;background:var(--bg-subtle);color:var(--text-dim);">NEW</span>'}</td>
          <td class="dim">${u.age ?? "—"}</td>
          <td class="dim">${escapeHtml(u.city || "—")}</td>
          <td class="tabular">${u.tradeCount}</td>
          <td class="tabular">${u.cashRupees != null ? formatRupees(u.cashRupees * 100, { compact: true }) : "—"}</td>
          <td class="dim text-xs">${formatDateShort(u.lastActive)}</td>
        </tr>
      `).join("");
      wireRowClicks(main);
    }
  });
  main.querySelectorAll(".admin-table th[data-col]").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (sortBy === col) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortBy = col; sortDir = "desc"; }
      render(main);
    });
  });
  wireRowClicks(main);
}

function colHead(col, label) {
  const arrow = sortBy === col ? (sortDir === "asc" ? " ↑" : " ↓") : "";
  return `<th data-col="${col}" class="sortable">${label}${arrow}</th>`;
}

function wireRowClicks(main) {
  main.querySelectorAll(".admin-table tbody tr").forEach(tr => {
    tr.addEventListener("click", async () => {
      const id = tr.dataset.userId;
      openUserModal(id);
    });
  });
}

async function openUserModal(id) {
  const host = document.getElementById("modal-root");
  host.innerHTML = `
    <div class="modal-overlay" role="dialog" aria-modal="true" id="admin-user-overlay">
      <div class="modal" style="max-width: 820px; max-height: 86vh; overflow: auto;">
        <div class="modal-head">
          <h2>Loading…</h2>
          <button class="btn btn-ghost btn-icon" aria-label="Close" id="admin-close-modal">✕</button>
        </div>
        <div class="modal-body" id="admin-user-body">
          <div class="muted">Fetching profile + holdings + transactions…</div>
        </div>
      </div>
    </div>
  `;
  document.getElementById("admin-close-modal").addEventListener("click", () => host.innerHTML = "");
  document.getElementById("admin-user-overlay").addEventListener("click", (e) => {
    if (e.target.id === "admin-user-overlay") host.innerHTML = "";
  });
  await loadUser(id);
  if (!document.getElementById("admin-user-body")) return;   // user closed
  paintUserModal();
}

function paintUserModal() {
  const host = document.getElementById("modal-root");
  const body = document.getElementById("admin-user-body");
  const head = host.querySelector(".modal-head h2");
  if (!body || !head) return;
  if (userDetail?.error) {
    body.innerHTML = `<div style="color: var(--negative);">${escapeHtml(userDetail.error)}</div>`;
    head.textContent = "Error";
    return;
  }
  const { profile, portfolio, holdings, transactions, coachMessages, portfolioHistory } = userDetail;
  head.innerHTML = `${escapeHtml(profile.display_name || profile.username)} <span class="dim text-sm">@${escapeHtml(profile.username)}</span>`;

  const histValues = (portfolioHistory || []).map(h => (h.value_paise || 0) / 100);
  const histSvg = histValues.length > 1
    ? `<div style="height: 180px;">${areaChart(histValues, { height: 180, color: "var(--brand)", paddingLeft: 40 })}</div>`
    : `<div class="muted text-sm" style="padding: var(--sp-3); border: 1px dashed var(--border); border-radius: var(--r); text-align:center;">No portfolio history recorded yet.</div>`;

  const totalHoldValue = (holdings || []).reduce((a, h) => a + (h.qty || 0) * (h.avg_cost_paise || 0), 0) / 100;
  const cashRupees = (portfolio?.cash_paise || 0) / 100;
  const totalValue = cashRupees + totalHoldValue;

  body.innerHTML = `
    <div class="admin-user-grid">
      <div>
        <div class="admin-user-section-label">Profile</div>
        <div class="admin-kv"><span>Email</span><span>${escapeHtml(profile.email || "—")}</span></div>
        <div class="admin-kv"><span>Age</span><span>${profile.age ?? "—"}</span></div>
        <div class="admin-kv"><span>School</span><span>${escapeHtml(profile.school || "—")}</span></div>
        <div class="admin-kv"><span>Class code</span><span>${escapeHtml(profile.class_code || "—")}</span></div>
        <div class="admin-kv"><span>City</span><span>${escapeHtml(profile.city || "—")}</span></div>
        <div class="admin-kv"><span>Risk profile</span><span>${escapeHtml(profile.risk_profile || "—")}</span></div>
        <div class="admin-kv"><span>Parent email</span><span>${escapeHtml(profile.parent_email || "—")}</span></div>
        <div class="admin-kv"><span>Consent</span><span>${profile.parent_consent_at ? formatDateShort(profile.parent_consent_at) : "—"}</span></div>
        <div class="admin-kv"><span>Onboarded</span><span>${profile.onboarded ? "Yes" : "No"}</span></div>
        <div class="admin-kv"><span>Joined</span><span>${formatDateShort(profile.created_at)}</span></div>
      </div>
      <div>
        <div class="admin-user-section-label">Money</div>
        <div class="admin-kv"><span>Cash</span><span>${formatRupees(cashRupees * 100)}</span></div>
        <div class="admin-kv"><span>Holdings value (cost-basis)</span><span>${formatRupees(totalHoldValue * 100)}</span></div>
        <div class="admin-kv"><span>Starting cash</span><span>${formatRupees((portfolio?.starting_cash_paise || 10000000))}</span></div>
        <div class="admin-kv" style="border-top: 1px solid var(--divider); padding-top: 6px; margin-top: 6px;"><span class="font-semi">Total portfolio</span><span class="font-semi">${formatRupees(totalValue * 100)}</span></div>
        <div class="admin-user-section-label" style="margin-top: var(--sp-3);">Activity</div>
        <div class="admin-kv"><span>Trades</span><span>${transactions?.length || 0}</span></div>
        <div class="admin-kv"><span>Coach messages</span><span>${coachMessages?.length || 0}</span></div>
        <div class="admin-kv"><span>Last active</span><span>${portfolio?.updated_at ? formatDateShort(portfolio.updated_at) : "—"}</span></div>
      </div>
    </div>

    <div class="admin-user-section-label" style="margin-top: var(--sp-4);">Portfolio value over time</div>
    ${histSvg}

    <div class="admin-user-section-label" style="margin-top: var(--sp-4);">Holdings (${holdings?.length || 0})</div>
    ${holdings?.length ? `<table class="admin-table"><thead><tr><th>Symbol</th><th>Qty</th><th>Avg cost</th><th>Cost basis</th><th>First bought</th></tr></thead><tbody>
      ${holdings.map(h => `<tr><td>${escapeHtml(h.symbol)}</td><td class="tabular">${h.qty}</td><td class="tabular">${formatRupees(h.avg_cost_paise || 0)}</td><td class="tabular">${formatRupees((h.qty || 0) * (h.avg_cost_paise || 0))}</td><td class="dim text-xs">${formatDateShort(h.first_bought_at)}</td></tr>`).join("")}
    </tbody></table>` : `<div class="muted text-sm">No holdings.</div>`}

    <div class="admin-user-section-label" style="margin-top: var(--sp-4);">Recent transactions (${transactions?.length || 0})</div>
    ${transactions?.length ? `<table class="admin-table"><thead><tr><th>When</th><th>Side</th><th>Symbol</th><th>Qty</th><th>Price</th></tr></thead><tbody>
      ${transactions.slice(0, 50).map(t => `<tr><td class="dim text-xs">${formatDateShort(t.ts)}</td><td><span class="pill ${t.side === "BUY" ? "pill-green" : "pill-red"}" style="font-size:10px;">${t.side}</span></td><td>${escapeHtml(t.symbol)}</td><td class="tabular">${t.qty}</td><td class="tabular">${formatRupees(t.price_paise || 0)}</td></tr>`).join("")}
    </tbody></table>` : `<div class="muted text-sm">No trades.</div>`}
  `;
}

function filterAndSort(users, q, by, dir) {
  let list = users;
  if (q) {
    const n = q.toLowerCase();
    list = list.filter(u =>
      (u.username || "").toLowerCase().includes(n) ||
      (u.displayName || "").toLowerCase().includes(n) ||
      (u.email || "").toLowerCase().includes(n) ||
      (u.school || "").toLowerCase().includes(n) ||
      (u.city || "").toLowerCase().includes(n)
    );
  }
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

function formatDateShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)}h ago`;
  if (diffMs < 7 * 86400_000) return `${Math.floor(diffMs / 86400_000)}d ago`;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
