// =============================================================================
// LEADERBOARD — Real users only. Rows come from Supabase's leaderboard_view
// (onboarded users ordered by return_bps desc), augmented with real
// StockSaathi accounts on the local device (other profiles stored in
// localStorage). Current user is appended if not already present. No SEED
// fallback — an honest short board beats a polished fake one.
// =============================================================================

import { getState, getPortfolioReturnPct, subscribe } from "../state.js";
import { listAccountsPublic } from "../auth/accounts.js";
import { dbLeaderboard } from "../db/sync.js";
import { sb } from "../db/supabase.js";

let scope = "GLOBAL";
let windowTf = "WEEKLY";

export function renderLeaderboard(main) {
  let cancelled = false;
  let dbRows = null;
  let dbLoaded = false;     // flips true after the first DB poll completes (success or fail)
  // Show a skeleton immediately so the user doesn't see a blank table for
  // the 1-2 s before the first Supabase fetch returns. Once dbLoaded
  // flips, renderInner() takes over with whatever real rows exist —
  // even if that's just the current user on an empty region.
  renderSkeleton(main);
  const unsub = subscribe(() => { if (!cancelled && dbLoaded) render(); });
  window.addEventListener("hashchange", () => { cancelled = true; unsub?.(); }, { once: true });

  // Watchdog: if sb() or dbLeaderboard() hangs for any reason (RLS issue,
  // Supabase slow, network flaky), force dbLoaded=true after 4 seconds
  // so the user is never stuck on an infinite skeleton. renderInner()
  // will then show whatever rows we have (possibly just the current user).
  const watchdog = setTimeout(() => {
    if (!dbLoaded && !cancelled) {
      console.warn("[leaderboard] 4s watchdog: forcing dbLoaded=true");
      dbLoaded = true;
      render();
    }
  }, 4000);

  // Poll real leaderboard every 20s. Each await is wrapped in a timeout
  // race so a slow/hung upstream can never starve the UI.
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
      clearTimeout(watchdog);
      dbLoaded = true;
      if (!cancelled) render();
      await new Promise(r => setTimeout(r, 20_000));
    }
  })();

  function render() {
    if (!dbLoaded) { renderSkeleton(main); return; }
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

    // Real rows from Supabase's leaderboard_view only — no more SEED
    // fallback. An empty or tiny board is honest; fake competitors just
    // confuse the user into trusting ranks that don't reflect reality.
    // If there are zero real users besides self, the augmentation below
    // (device-local accounts + self-append) still runs and we end up
    // with at least the current user on the board.
    let entries = (dbRows || []).map(r => ({
      id: r.user_id,
      name: r.display_name,
      school: r.school || "StockSaathi user",
      returnPct: Math.round(Number(r.return_bps) / 10) / 10,  // bps → %
      trades: Number(r.trades) || 0,
      realUser: true,
      me: r.user_id === state.user.id,
    }));

    // Augment with real StockSaathi users on this device (other accounts)
    let realUsers = [];
    try { realUsers = (listAccountsPublic() || []).filter(u => u.id !== user.id); } catch {}
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

    // Append me (if not already present from DB)
    if (!entries.some(e => e.me)) {
      entries.push({
        id: "me", name: myName, school: user.school || "Your school",
        class: "", returnPct: Math.round(myReturn * 10) / 10,
        trades: transactions.length, daysActive: 1, me: true,
      });
    }

    // Filter by scope
    if (scope === "SCHOOL" && user.school) {
      entries = entries.filter(u => u.school === user.school || u.me);
    }
    if (scope === "FRIENDS") {
      const friendIds = new Set(friends.map(f => f && f.id).filter(Boolean));
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
          <button class="lb-tab ${scope === "FRIENDS" ? "active" : ""}" data-scope="FRIENDS">👥 Friends (${friends.length})</button>
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

// Skeleton loader — shown while the first DB poll is in-flight so the user
// doesn't see a blank table. 10 shimmer rows match the real table layout
// so the transition to real data is dimensionally smooth (no layout shift).
function renderSkeleton(main) {
  const rows = [];
  // Widths chosen to look organic — not all rows the same.
  const nameWidths = ["60%", "45%", "72%", "50%", "65%", "55%", "48%", "70%", "52%", "58%"];
  const schoolWidths = ["70%", "50%", "80%", "60%", "55%", "65%", "72%", "58%", "48%", "62%"];
  for (let i = 0; i < 10; i++) {
    rows.push(`
      <tr>
        <td><span class="lb-rank ${i < 3 ? "top3" : ""}" style="opacity:0.35;">${i + 1}</span></td>
        <td>
          <div class="lb-skel-line" style="width:${nameWidths[i]}; height:15px;"></div>
          <div class="lb-skel-line" style="width:30%; height:10px; margin-top:4px; opacity:0.6;"></div>
        </td>
        <td><div class="lb-skel-line" style="width:${schoolWidths[i]}; height:13px;"></div></td>
        <td class="num"><div class="lb-skel-line" style="width:32px; height:13px; margin-left:auto;"></div></td>
        <td class="num"><div class="lb-skel-line" style="width:54px; height:13px; margin-left:auto;"></div></td>
      </tr>
    `);
  }
  main.innerHTML = `
    <div style="margin-bottom: var(--sp-5);">
      <h1>Leaderboard</h1>
      <p class="muted">Ranked by portfolio return since ₹1,00,000 start.</p>
    </div>
    <div class="flex gap-2 wrap" style="margin-bottom: var(--sp-5);">
      <div class="lb-tabs">
        <button class="lb-tab active" disabled>🌏 Global</button>
        <button class="lb-tab" disabled>🏫 My School</button>
        <button class="lb-tab" disabled>👥 Friends</button>
      </div>
      <div class="lb-tabs">
        <button class="lb-tab" disabled>Today</button>
        <button class="lb-tab active" disabled>Week</button>
        <button class="lb-tab" disabled>Month</button>
      </div>
    </div>
    <div class="card" style="padding: 0; overflow: hidden;">
      <div class="table-wrap">
        <table class="table lb-skeleton">
          <thead>
            <tr>
              <th style="width: 72px">Rank</th>
              <th>Player</th>
              <th>School</th>
              <th class="num">Trades</th>
              <th class="num">Return</th>
            </tr>
          </thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      </div>
    </div>
  `;
}
