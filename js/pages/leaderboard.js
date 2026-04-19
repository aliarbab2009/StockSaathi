// =============================================================================
// LEADERBOARD — Seeded competitors + real StockSaathi users (from other
// accounts on this device). User appears inline based on their return %.
// =============================================================================

import { LEADERBOARD as SEED } from "../data/leaderboard.js";
import { getState, getPortfolioReturnPct, subscribe } from "../state.js";
import { listAccountsPublic } from "../auth/accounts.js";

let scope = "GLOBAL";
let windowTf = "WEEKLY";

export function renderLeaderboard(main) {
  render();
  const unsub = subscribe(render);
  window.addEventListener("hashchange", () => unsub?.(), { once: true });

  function render() {
    const state = getState();
    const myReturn = getPortfolioReturnPct(state) * 100;
    const myName = state.user.displayName || state.user.username || "You";

    // Base seeded competitors
    let entries = SEED.map(u => ({ ...u }));

    // Augment with real StockSaathi users on this device (other accounts)
    const realUsers = listAccountsPublic().filter(u => u.id !== state.user.id);
    for (const u of realUsers) {
      // Load their state to get their return %
      try {
        const raw = localStorage.getItem(`ss.userstate.${u.id}`);
        if (!raw) continue;
        const st = JSON.parse(raw);
        if (!st?.portfolio) continue;
        const start = st.portfolio.startingCashPaise || 1_00_00_000;
        let total = st.portfolio.cashPaise || 0;
        // Approximate with avgCost (we don't have live prices here sync)
        for (const [sym, h] of Object.entries(st.holdings || {})) {
          total += Math.round(h.qty * h.avgCostPaise);
        }
        const retPct = ((total - start) / start) * 100;
        entries.push({
          id: u.id,
          name: u.displayName,
          school: u.school || "StockSaathi user",
          class: "",
          returnPct: Math.round(retPct * 10) / 10,
          trades: (st.transactions || []).length,
          daysActive: 1,
          realUser: true,
        });
      } catch {}
    }

    // Append me
    entries.push({
      id: "me", name: myName, school: state.user.school || "Your school",
      class: "", returnPct: Math.round(myReturn * 10) / 10,
      trades: state.transactions.length, daysActive: 1, me: true,
    });

    // Filter by scope
    if (scope === "SCHOOL" && state.user.school) {
      entries = entries.filter(u => u.school === state.user.school || u.me);
    }
    if (scope === "FRIENDS") {
      const friendIds = new Set(state.friends.map(f => f.id));
      entries = entries.filter(u => u.me || friendIds.has(u.id));
    }

    entries.sort((a, b) => b.returnPct - a.returnPct);
    entries.forEach((e, i) => { e.rank = i + 1; });

    const top10 = entries.slice(0, 10);
    const me = entries.find(e => e.me);

    main.innerHTML = `
      <div style="margin-bottom: var(--sp-5);">
        <h1>Leaderboard</h1>
        <p class="muted">Ranked by portfolio return since ₹1,00,000 start.</p>
      </div>

      <div class="flex gap-2 wrap" style="margin-bottom: var(--sp-5);">
        <div class="lb-tabs">
          <button class="lb-tab ${scope === "GLOBAL" ? "active" : ""}" data-scope="GLOBAL">🌏 Global</button>
          <button class="lb-tab ${scope === "SCHOOL" ? "active" : ""}" data-scope="SCHOOL">🏫 My School</button>
          <button class="lb-tab ${scope === "FRIENDS" ? "active" : ""}" data-scope="FRIENDS">👥 Friends (${state.friends.length})</button>
        </div>
        <div class="lb-tabs">
          <button class="lb-tab ${windowTf === "DAILY" ? "active" : ""}" data-window="DAILY">Today</button>
          <button class="lb-tab ${windowTf === "WEEKLY" ? "active" : ""}" data-window="WEEKLY">Week</button>
          <button class="lb-tab ${windowTf === "MONTHLY" ? "active" : ""}" data-window="MONTHLY">Month</button>
        </div>
      </div>

      <div class="card" style="padding: 0; overflow: hidden;">
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th style="width: 72px">Rank</th>
                <th>Player</th>
                <th>School</th>
                <th class="num">Trades</th>
                <th class="num">Return</th>
              </tr>
            </thead>
            <tbody>
              ${top10.map(u => renderRow(u)).join("")}
              ${!me || me.rank <= 10 ? "" : `
                <tr><td colspan="5" style="text-align: center; padding: 12px;" class="dim">…</td></tr>
                ${renderRow(me)}
              `}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" style="margin-top: var(--sp-5);">
        <h3 style="margin-bottom: var(--sp-2);">How ranking works</h3>
        <p class="muted text-sm" style="line-height: 1.7;">
          Ranking is based on <strong>return percentage</strong>, not absolute portfolio value —
          everyone starts at ₹1,00,000. A high return is great, but the <em>Report Card</em> is what
          you'll actually show your parents — it measures the quality of your decisions, not just outcomes.
        </p>
      </div>
    `;

    main.querySelectorAll("[data-scope]").forEach(btn => btn.addEventListener("click", () => { scope = btn.dataset.scope; render(); }));
    main.querySelectorAll("[data-window]").forEach(btn => btn.addEventListener("click", () => { windowTf = btn.dataset.window; render(); }));
  }
}

function renderRow(u) {
  const top3 = u.rank <= 3;
  return `
    <tr class="${u.me ? "lb-row-user" : ""}">
      <td><span class="lb-rank ${top3 ? "top3" : ""}">${u.rank}</span></td>
      <td>
        <div class="lb-name">${escapeHtml(u.name)}${u.me ? ' <span class="pill pill-brand">YOU</span>' : u.realUser ? ' <span class="pill pill-blue">REAL</span>' : ""}</div>
        ${u.class ? `<div class="lb-school">${escapeHtml(u.class)}</div>` : ""}
      </td>
      <td class="lb-school">${escapeHtml(u.school)}</td>
      <td class="num">${u.trades}</td>
      <td class="num ${u.returnPct > 0 ? "up" : u.returnPct < 0 ? "down" : ""}">${u.returnPct > 0 ? "+" : ""}${u.returnPct.toFixed(1)}%</td>
    </tr>
  `;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
