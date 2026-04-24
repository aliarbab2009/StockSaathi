// =============================================================================
// LEADERBOARD — Real users only. Rows come from Supabase's leaderboard_view
// (onboarded users ordered by return_bps desc), augmented with real
// StockSaathi accounts on the local device (other profiles stored in
// localStorage). Current user is appended if not already present. No SEED
// fallback — an honest short board beats a polished fake one.
// =============================================================================

import { LEADERBOARD as SEED } from "../data/leaderboard.js";
import { getState, getPortfolioReturnPct, subscribe } from "../state.js";
import { listAccountsPublic } from "../auth/accounts.js";
import { dbLeaderboard } from "../db/sync.js";
import { sb } from "../db/supabase.js";

let scope = "GLOBAL";
let windowTf = "WEEKLY";

export function renderLeaderboard(main) {
  let cancelled = false;
  let dbRows = null;
  // No more skeleton / dbLoaded gating — we render the current user
  // immediately (and any device-local accounts) so the page is usable
  // from the first frame. The Supabase poll below fills in real
  // competitors as they arrive. Previously the page showed a shimmer
  // skeleton for 4 s before the watchdog fired, then collapsed to the
  // same "just you" state it could have shown from the start.
  render();
  const unsub = subscribe(() => { if (!cancelled) render(); });
  window.addEventListener("hashchange", () => { cancelled = true; unsub?.(); }, { once: true });

  // Poll real leaderboard every 20 s. Each await is wrapped in a
  // timeout race so a slow/hung upstream can never starve the UI.
  (async function liveLoop() {
    while (!cancelled) {
      try {
        const client = await Promise.race([
          sb(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("sb_timeout")), 4000)),
        ]);
        if (client) {
          dbRows = await Promise.race([
            dbLeaderboard({ scope, limit: 50 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("dbLeaderboard_timeout")), 6000)),
          ]);
        }
      } catch (e) { console.warn("leaderboard poll:", e?.message || e); }
      if (!cancelled) render();
      await new Promise(r => setTimeout(r, 20_000));
    }
  })();

  function render() {
    try { renderInner(); }
    catch (e) {
      console.error("leaderboard render failed:", e);
      main.innerHTML = `<div class="empty-state"><span class="emoji">😬</span><h3>Leaderboard hit a snag</h3><div class="muted text-sm" style="max-width:420px; margin:0 auto;">Technical: <code>${escapeHtml(String(e?.message || e))}</code></div><div style="margin-top:var(--sp-4);"><a href="#/portfolio" class="btn btn-primary">Back to portfolio</a></div></div>`;
    }
  }
  function renderInner() {
    const state = getState() || {};
    const user = state.user || {};
    const friends = Array.isArray(state.friends) ? state.friends : [];
    const transactions = Array.isArray(state.transactions) ? state.transactions : [];
    let myReturn = 0;
    try { myReturn = (getPortfolioReturnPct(state) || 0) * 100; } catch { myReturn = 0; }
    const myName = user.displayName || user.username || "You";

    // Separate REAL competitors from PRACTICE competitors. Real =
    // Supabase onboarded users + device-local StockSaathi accounts +
    // current user (always included). Practice = SEED. Two clearly-
    // labeled sections, independent ranking within each. User's row
    // is always visible in the Real section regardless of rank.
    const realEntries = (dbRows || []).map(r => ({
      id: r.user_id,
      name: r.display_name,
      school: r.school || "StockSaathi user",
      returnPct: Math.round(Number(r.return_bps) / 10) / 10,  // bps → %
      trades: Number(r.trades) || 0,
      me: r.user_id === state.user.id,
    }));

    // Augment with real StockSaathi users on this device (other accounts)
    let realUsers = [];
    try { realUsers = (listAccountsPublic() || []).filter(u => u.id !== user.id); } catch {}
    for (const u of realUsers) {
      try {
        const raw = localStorage.getItem(`ss.userstate.${u.id}`);
        if (!raw) continue;
        const st = JSON.parse(raw);
        if (!st?.portfolio) continue;
        const start = st.portfolio.startingCashPaise || 1_00_00_000;
        let total = st.portfolio.cashPaise || 0;
        for (const [sym, h] of Object.entries(st.holdings || {})) {
          total += Math.round(h.qty * h.avgCostPaise);
        }
        const retPct = ((total - start) / start) * 100;
        // De-dup against DB rows in case the DB already returned this user.
        if (realEntries.some(e => e.id === u.id)) continue;
        realEntries.push({
          id: u.id,
          name: u.displayName,
          school: u.school || "StockSaathi user",
          returnPct: Math.round(retPct * 10) / 10,
          trades: (st.transactions || []).length,
          me: false,
        });
      } catch {}
    }

    // Always include the current user in the Real section, even at 0%.
    if (!realEntries.some(e => e.me)) {
      realEntries.push({
        id: "me",
        name: myName,
        school: user.school || "Your school",
        returnPct: Math.round(myReturn * 10) / 10,
        trades: transactions.length,
        me: true,
      });
    }

    // Scope filters apply to REAL section only (SEED is always global
    // practice context — nobody has "friends" among seeded characters).
    let realScoped = realEntries.slice();
    if (scope === "SCHOOL" && user.school) {
      realScoped = realScoped.filter(u => u.school === user.school || u.me);
    }
    if (scope === "FRIENDS") {
      const friendIds = new Set(friends.map(f => f && f.id).filter(Boolean));
      realScoped = realScoped.filter(u => u.me || friendIds.has(u.id));
    }

    realScoped.sort((a, b) => b.returnPct - a.returnPct);
    realScoped.forEach((e, i) => { e.rank = i + 1; });

    const seedRanked = SEED.map(u => ({ ...u }));
    seedRanked.sort((a, b) => b.returnPct - a.returnPct);
    seedRanked.forEach((e, i) => { e.rank = i + 1; });

    const me = realScoped.find(e => e.me);
    const realCount = realScoped.length;

    // Only show the SEED "Practice" section on Global scope — on School /
    // Friends the user is asking for THEIR peers specifically, not generic
    // practice characters.
    const showPractice = scope === "GLOBAL";

    main.innerHTML = `
      <div style="margin-bottom: var(--sp-5);">
        <h1>Leaderboard</h1>
        <p class="muted">Ranked by portfolio return since ₹1,00,000 start.</p>
      </div>

      <div class="flex gap-2 wrap" style="margin-bottom: var(--sp-5);">
        <div class="lb-tabs">
          <button class="lb-tab ${scope === "GLOBAL" ? "active" : ""}" data-scope="GLOBAL">🌏 Global</button>
          <button class="lb-tab ${scope === "SCHOOL" ? "active" : ""}" data-scope="SCHOOL">🏫 My School</button>
          <button class="lb-tab ${scope === "FRIENDS" ? "active" : ""}" data-scope="FRIENDS">👥 Friends (${friends.length})</button>
        </div>
        <div class="lb-tabs">
          <button class="lb-tab ${windowTf === "DAILY" ? "active" : ""}" data-window="DAILY">Today</button>
          <button class="lb-tab ${windowTf === "WEEKLY" ? "active" : ""}" data-window="WEEKLY">Week</button>
          <button class="lb-tab ${windowTf === "MONTHLY" ? "active" : ""}" data-window="MONTHLY">Month</button>
        </div>
      </div>

      ${me ? `
        <div class="card" style="margin-bottom: var(--sp-4); padding: var(--sp-4); background: color-mix(in srgb, var(--brand) 8%, var(--bg-soft)); border: 1px solid color-mix(in srgb, var(--brand) 38%, var(--border));">
          <div class="flex items-center gap-3 wrap">
            <div class="lb-rank top3" style="background: var(--brand); color: white; min-width: 48px; text-align: center;">#${me.rank}</div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-weight: 600; color: var(--text-strong);">You're rank <strong>#${me.rank}</strong> of ${realCount} real ${realCount === 1 ? "player" : "players"}</div>
              <div class="muted text-xs" style="line-height: 1.5;">${me.returnPct > 0 ? `+${me.returnPct.toFixed(1)}%` : `${me.returnPct.toFixed(1)}%`} return · ${me.trades} ${me.trades === 1 ? "trade" : "trades"}</div>
            </div>
          </div>
        </div>
      ` : ""}

      <div class="card" style="padding: 0; overflow: hidden;">
        <div style="padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--divider); display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;">
          <strong style="color: var(--text-strong); font-size: var(--text-md);">Real players</strong>
          <span class="pill pill-brand" style="font-size: 10px;">${realCount}</span>
          ${scope !== "GLOBAL" ? `<span class="muted text-xs">in ${scope === "SCHOOL" ? "your school" : "your friends"}</span>` : ""}
        </div>
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
              ${realScoped.length
                ? realScoped.map(u => renderRow(u)).join("")
                : `<tr><td colspan="5" style="text-align: center; padding: var(--sp-5);" class="muted text-sm">No real players match this filter yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>

      ${showPractice ? `
        <div class="card" style="padding: 0; overflow: hidden; margin-top: var(--sp-4); opacity: 0.92;">
          <div style="padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--divider); display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap;">
            <strong style="color: var(--text-muted); font-size: var(--text-md);">Practice competitors</strong>
            <span class="pill pill-neutral" style="font-size: 10px;">${seedRanked.length}</span>
            <span class="muted text-xs">simulated benchmarks so you always have a board to push against</span>
          </div>
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
                ${seedRanked.slice(0, 10).map(u => renderRow(u)).join("")}
              </tbody>
            </table>
          </div>
        </div>
      ` : ""}

      <div class="card" style="margin-top: var(--sp-5);">
        <h3 style="margin-bottom: var(--sp-2);">How ranking works</h3>
        <p class="muted text-sm" style="line-height: 1.7;">
          The <strong>Real players</strong> board is other StockSaathi users pulled live from Supabase —
          your rank here is the one that counts. The <strong>Practice competitors</strong> section below
          is a set of simulated characters so the board is never empty while the user base grows.
          Rankings are by <strong>return percentage</strong> — everyone starts at ₹1,00,000, and
          the <em>Report Card</em> (not this page) is what actually measures decision quality.
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
        <div class="lb-name">${escapeHtml(u.name)}${u.me ? ' <span class="pill pill-brand">YOU</span>' : ""}</div>
        ${u.class ? `<div class="lb-school">${escapeHtml(u.class)}</div>` : ""}
      </td>
      <td class="lb-school">${escapeHtml(u.school)}</td>
      <td class="num">${u.trades}</td>
      <td class="num ${u.returnPct > 0 ? "up" : u.returnPct < 0 ? "down" : ""}">${u.returnPct > 0 ? "+" : ""}${u.returnPct.toFixed(1)}%</td>
    </tr>
  `;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
