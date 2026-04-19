// =============================================================================
// PORTFOLIO — Dashboard. Clean state, news column, live refresh.
// =============================================================================

import {
  getState, subscribe, getPortfolioValue, getHoldingsValue, getPortfolioReturnPct,
  getHoldingPLPaise, getHoldingPLPct,
} from "../state.js";
import { formatRupees, formatPct, deltaClass, formatQty } from "../money.js";
import { getInstrument } from "../data/universe.js";
import { getPriceAt, getTodayChange } from "../data/prices.js";
import { getQuoteBatch, getDataSource, subscribeToQuotes, getCachedQuotes } from "../data/marketData.js";
import { listPendingOrders, cancelOrder } from "../features/limitOrders.js";
import { getNews, fmtRelativeTime, labelSentiment } from "../data/news.js";
import { areaChart } from "../components/charts.js";

let newsItems = [];
let quoteCache = {};
let pendingOrders = [];

export function renderPortfolio(main) {
  let cancelled = false;
  let pollUnsub = null;

  // Instant first paint: prefill cache from localStorage-backed in-memory cache
  const state0Syms = Object.keys(getState().holdings || {});
  if (state0Syms.length) quoteCache = { ...quoteCache, ...getCachedQuotes(state0Syms) };

  render();
  const unsub = subscribe(() => { if (!cancelled) render(); });
  const onLeave = () => { cancelled = true; unsub?.(); pollUnsub?.(); };
  window.addEventListener("hashchange", onLeave, { once: true });

  refreshData();

  // Poll live quotes for user's holdings every 15s
  const state0 = getState();
  const holdingSyms = Object.keys(state0.holdings || {});
  if (holdingSyms.length) {
    pollUnsub = subscribeToQuotes(holdingSyms, (q) => {
      if (cancelled) return;
      quoteCache = { ...quoteCache, ...q };
      render();
    }, 15_000);
  }

  // Load pending limit orders
  listPendingOrders().then(o => { if (!cancelled) { pendingOrders = o; render(); } }).catch(() => {});

  async function refreshData() {
    const state = getState();
    const syms = Object.keys(state.holdings);
    if (syms.length) {
      try {
        const q = await getQuoteBatch(syms);
        if (cancelled) return;
        quoteCache = q;
        render();
      } catch (e) { console.warn("quote refresh:", e); }
    }
    try {
      const items = await getNews({ limit: 5, filterSymbols: syms.length ? syms : null });
      if (cancelled) return;
      newsItems = items;
    } catch {
      try {
        const items = await getNews({ limit: 5 });
        if (cancelled) return;
        newsItems = items;
      } catch {}
    }
    if (cancelled) return;
    render();
  }

  function render() {
    const state = getState();
    const pfValue = getPortfolioValue(state);
    const holdValue = getHoldingsValue(state);
    const returnPct = getPortfolioReturnPct(state);
    const cash = state.portfolio.cashPaise;
    const deltaPaise = pfValue - state.portfolio.startingCashPaise;

    const holdings = Object.entries(state.holdings)
      .map(([sym, h]) => {
        const inst = getInstrument(sym);
        if (!inst) return null;
        const quote = quoteCache[sym];
        const curPx = quote?.pricePaise ?? getPriceAt(sym, 0);
        const value = Math.round(h.qty * curPx);
        const pl = Math.round((curPx - h.avgCostPaise) * h.qty);
        const plPct = (curPx - h.avgCostPaise) / h.avgCostPaise;
        const dayChange = quote?.changePct ?? getTodayChange(sym);
        return { sym, inst, h, curPx, value, pl, plPct, dayChange, source: quote?.source };
      })
      .filter(Boolean)
      .sort((a, b) => b.value - a.value);

    const src = getDataSource();
    const hasRealHistory = state.portfolioHistory && state.portfolioHistory.length > 1;

    main.innerHTML = `
      <div class="portfolio-hero">
        <div>
          <div class="dim text-xs uppercase" style="margin-bottom: 6px;">
            ${escapeHtml(state.user.displayName || state.user.username || "Your")} portfolio
          </div>
          <div class="pf-value tabular">${formatRupees(pfValue)}</div>
          <div class="pf-delta tabular ${deltaClass(deltaPaise)}">
            ${formatRupees(deltaPaise, { sign: true })} (${formatPct(returnPct, { sign: true })}) since start
          </div>
        </div>
        <div class="flex gap-2 wrap">
          <a href="#/stocks" class="btn btn-primary">+ Invest</a>
          <a href="#/friends" class="btn btn-ghost">Send money</a>
          <a href="#/report-card" class="btn btn-ghost">Report card</a>
        </div>
      </div>

      <div class="portfolio-stats">
        <div class="stat-tile"><div class="l">Cash</div><div class="v tabular">${formatRupees(cash, { compact: true })}</div></div>
        <div class="stat-tile"><div class="l">Invested</div><div class="v tabular">${formatRupees(holdValue, { compact: true })}</div></div>
        <div class="stat-tile"><div class="l">Holdings</div><div class="v tabular">${holdings.length}</div></div>
        <div class="stat-tile"><div class="l">Trades</div><div class="v tabular">${state.transactions.length}</div></div>
      </div>

      <div class="portfolio-grid">
        <div class="flex-col gap-4">
          <div class="card">
            <div class="card-head">
              <h3>Value over time</h3>
              <span class="data-badge"><span class="dot"></span> ${escapeHtml(src.name)}</span>
            </div>
            <div style="height: 260px; position: relative;">
              ${hasRealHistory
                ? areaChart(state.portfolioHistory, { height: 260, color: "var(--brand)", paddingLeft: 60 })
                : `<div style="height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border: 1px dashed var(--border); border-radius: var(--r); background: var(--surface);">
                    <div style="font-size: 40px; opacity: 0.45;">📈</div>
                    <div class="font-semi" style="color: var(--text-strong);">Chart will start drawing soon</div>
                    <div class="muted text-sm" style="text-align: center; max-width: 340px;">Use StockSaathi for a few days — we'll plot your real portfolio value once there's enough history to draw an accurate line.</div>
                  </div>`}
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <h3>Holdings</h3>
              ${holdings.length ? `<span class="dim text-xs">${holdings.length} position${holdings.length !== 1 ? "s" : ""}</span>` : ""}
            </div>
            ${holdings.length ? renderHoldingsTable(holdings) : renderEmptyHoldings()}
          </div>

          ${pendingOrders.length ? `
            <div class="card">
              <div class="card-head">
                <h3>Pending limit orders (${pendingOrders.length})</h3>
              </div>
              <div class="flex-col gap-2">
                ${pendingOrders.map(o => {
                  const inst = getInstrument(o.symbol) || { name: o.symbol };
                  const limitRupees = Number(o.limit_price_paise) / 100;
                  return `
                    <div class="flex items-center justify-between" style="padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface);">
                      <div>
                        <div class="text-md"><span class="pill ${o.side === "BUY" ? "pill-green" : "pill-red"}">${o.side} LIMIT</span> ${escapeHtml(inst.name)}</div>
                        <div class="dim text-xs">${o.qty} × ₹${limitRupees.toFixed(2)} · ${timeSince(new Date(o.created_at))} ago</div>
                      </div>
                      <button class="btn btn-ghost btn-sm" data-cancel-order="${o.id}">Cancel</button>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          ` : ""}

          <div class="card">
            <div class="card-head"><h3>Recent activity</h3></div>
            ${renderActivity(state)}
          </div>
        </div>

        <div class="flex-col gap-4">
          <div class="card">
            <div class="card-head">
              <h3>In the news</h3>
              <a href="#/news" class="btn-link">See all →</a>
            </div>
            ${newsItems.length
              ? `<div class="flex-col gap-2">${newsItems.slice(0, 5).map(n => `
                  <a href="#/news" class="news-item" style="padding: 12px;" data-nid="${escapeAttr(n.id)}">
                    <div class="meta">
                      <span class="news-source">${escapeHtml(n.source)} · ${fmtRelativeTime(n.ts)}</span>
                      <span class="sentiment ${n.sentiment}">${labelSentiment(n.sentiment)}</span>
                    </div>
                    <div class="headline" style="font-size: var(--text-sm);">${escapeHtml(n.headline)}</div>
                  </a>`).join("")}</div>`
              : `<p class="muted text-sm">Loading market news…</p>`
            }
          </div>

          <div class="card">
            <div class="card-head"><h3>Quick actions</h3></div>
            <div class="flex-col gap-2">
              <a href="#/stocks" class="btn btn-ghost">📈 Browse markets</a>
              <a href="#/news" class="btn btn-ghost">📰 Market news</a>
              <a href="#/crash-replay" class="btn btn-ghost">⏱ Time travel</a>
              <a href="#/friends" class="btn btn-ghost">💸 Send money</a>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

function renderHoldingsTable(holdings) {
  return `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th></th>
            <th>Instrument</th>
            <th class="num">Qty</th>
            <th class="num">Avg cost</th>
            <th class="num">LTP</th>
            <th class="num">Today</th>
            <th class="num">Value</th>
            <th class="num">P&amp;L</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${holdings.map(h => `
            <tr class="clickable" data-sym="${h.sym}">
              <td><div class="stock-avatar" style="width: 32px; height: 32px; font-size: 10px;">${escapeHtml(h.inst.logo || h.sym.slice(0, 3))}</div></td>
              <td>
                <div class="font-semi" style="color: var(--text-strong);">${escapeHtml(h.inst.name)}</div>
                <div class="dim text-xs">${h.sym} · ${escapeHtml(h.inst.sector || "")}</div>
              </td>
              <td class="num">${formatQty(h.h.qty, h.inst.kind)}</td>
              <td class="num">${formatRupees(h.h.avgCostPaise)}</td>
              <td class="num">${formatRupees(h.curPx)}</td>
              <td class="num ${deltaClass(h.dayChange)}">${formatPct(h.dayChange, { sign: true })}</td>
              <td class="num">${formatRupees(h.value, { compact: true })}</td>
              <td class="num ${deltaClass(h.pl)}">
                <div>${formatRupees(h.pl, { sign: true, compact: true })}</div>
                <div style="font-size: 11px;">${formatPct(h.plPct, { sign: true })}</div>
              </td>
              <td><a class="btn btn-ghost btn-sm" href="#/stocks/${h.sym}">Trade</a></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderEmptyHoldings() {
  return `
    <div class="empty-state">
      <span class="emoji">📊</span>
      <h3>No holdings yet</h3>
      <p>Pick a stock or mutual fund to get started. Every trade triggers a behavioral reflection from the coach.</p>
      <a href="#/stocks" class="btn btn-primary">Browse markets</a>
    </div>
  `;
}

function renderActivity(state) {
  const txns = state.transactions.slice().reverse().slice(0, 5);
  const transfers = state.transfers.slice().reverse().slice(0, 3);
  if (!txns.length && !transfers.length) {
    return `<p class="muted text-sm" style="text-align: center; padding: var(--sp-4);">No activity yet. Your trades and transfers will show here.</p>`;
  }
  const rows = [];
  for (const t of txns) {
    const inst = getInstrument(t.symbol);
    rows.push({
      type: "trade",
      ts: t.ts,
      left: `<span class="pill ${t.side === "BUY" ? "pill-green" : "pill-red"}">${t.side}</span> ${inst ? escapeHtml(inst.name) : t.symbol}`,
      right: `${formatQty(t.qty, inst?.kind)} @ ${formatRupees(t.pricePaise)}`,
      amount: (t.side === "BUY" ? "−" : "+") + formatRupees(t.valuePaise, { compact: true }),
      ac: t.side === "BUY" ? "down" : "up",
    });
  }
  for (const t of transfers) {
    rows.push({
      type: "transfer",
      ts: t.ts,
      left: `<span class="pill ${t.direction === "in" ? "pill-green" : "pill-red"}">${t.direction === "in" ? "RECEIVED" : "SENT"}</span> ${escapeHtml(t.counterpartyName || "Transfer")}`,
      right: escapeHtml(t.note || ""),
      amount: (t.direction === "in" ? "+" : "−") + formatRupees(t.amountPaise, { compact: true }),
      ac: t.direction === "in" ? "up" : "down",
    });
  }
  rows.sort((a, b) => b.ts - a.ts);

  return `
    <div class="flex-col gap-2">
      ${rows.slice(0, 6).map(r => {
        const d = new Date(r.ts);
        const when = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) + " · " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
        return `
          <div class="flex items-center justify-between" style="padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface);">
            <div>
              <div class="text-md">${r.left}</div>
              <div class="dim text-xs">${when} · ${r.right}</div>
            </div>
            <div class="num font-bold ${r.ac}">${r.amount}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
