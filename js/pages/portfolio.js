// =============================================================================
// PORTFOLIO — Dashboard. Clean state, news column, live refresh.
// =============================================================================

import {
  getState, subscribe, getPortfolioValue, getHoldingsValue, getPortfolioReturnPct,
  getHoldingPLPaise, getHoldingPLPct,
} from "../state.js";
import { formatRupees, formatPct, deltaClass, formatQty } from "../money.js";
import { getInstrument } from "../data/universe.js";
import { getPriceAt, getTodayChange, marketStatus } from "../data/prices.js";
import { getQuoteBatch, getDataSource, subscribeToQuotes, getCachedQuotes } from "../data/marketData.js";
import { listPendingOrders, cancelOrder } from "../features/limitOrders.js";
import { getNews, fmtRelativeTime, labelSentiment } from "../data/news.js";
import { areaChart } from "../components/charts.js";
import { fetchDigest, cachedDigest } from "../features/portfolioDigest.js";

let newsItems = [];
let quoteCache = {};
let pendingOrders = [];
let aiDigest = null;      // { narrative, mood } | null
let aiDigestLoading = false;

export function renderPortfolio(main) {
  let cancelled = false;
  let pollUnsub = null;

  // Instant first paint: prefill cache from localStorage-backed in-memory cache
  const state0Syms = Object.keys(getState().holdings || {});
  if (state0Syms.length) quoteCache = { ...quoteCache, ...getCachedQuotes(state0Syms) };

  // Show any same-day cached AI digest immediately so the card isn't a
  // loading skeleton on reload.
  const state0 = getState();
  aiDigest = cachedDigest(state0.user?.id || "anon");

  render();
  const unsub = subscribe(() => { if (!cancelled) render(); });

  refreshData();

  // Poll live quotes for user's holdings every 15s
  const holdingSyms = Object.keys(state0.holdings || {});
  if (holdingSyms.length) {
    pollUnsub = subscribeToQuotes(holdingSyms, (q) => {
      if (cancelled) return;
      quoteCache = { ...quoteCache, ...q };
      render();
    }, 15_000);
  }

  // Load pending limit orders (initial fetch)
  listPendingOrders().then(o => { if (!cancelled) { pendingOrders = o; render(); } }).catch(() => {});

  // Live-refresh pending orders every 15 s so background-matcher fills
  // and cross-tab cancels propagate to the visible list without
  // requiring the user to navigate away and back. Symmetric with the
  // quote polling above. Shallow-compare (length + first id) so we
  // skip re-renders when nothing has moved.
  const pendingPoll = setInterval(async () => {
    if (cancelled) return;
    try {
      const o = await listPendingOrders();
      if (cancelled) return;
      const changed = o.length !== pendingOrders.length
        || (o[0]?.id !== pendingOrders[0]?.id);
      pendingOrders = o;
      if (changed) render();
    } catch (e) {
      console.warn("[portfolio] pending-orders poll failed:", e?.message || e);
    }
  }, 15_000);

  const onLeave = () => {
    cancelled = true;
    unsub?.();
    pollUnsub?.();
    clearInterval(pendingPoll);
  };
  window.addEventListener("hashchange", onLeave, { once: true });

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
    // Fire the AI digest once quotes + news have landed. Cached hits return
    // instantly; uncached generation runs ~2 s on Gemini Pro and patches in.
    refreshAiDigest();
  }

  async function refreshAiDigest() {
    if (aiDigestLoading) return;
    const state = getState();
    const userId = state.user?.id || "anon";
    const pf = getPortfolioValue(state);
    const holdings = Object.entries(state.holdings).map(([sym, h]) => {
      const inst = getInstrument(sym);
      const quote = quoteCache[sym];
      const curPx = quote?.pricePaise ?? getPriceAt(sym, 0);
      return {
        symbol: sym,
        name: inst?.name || sym,
        sector: inst?.sector || "",
        qty: h.qty,
        avgRupees: h.avgCostPaise / 100,
        curRupees: curPx / 100,
        dayPct: (quote?.changePct ?? getTodayChange(sym)) * 100,
        plPct: (curPx - h.avgCostPaise) / h.avgCostPaise,
      };
    });
    const payload = {
      totalRupees: pf / 100,
      deltaPct: getPortfolioReturnPct(state) * 100,
      cashRupees: state.portfolio.cashPaise / 100,
      holdings,
    };
    aiDigestLoading = true;
    render();
    try {
      const d = await fetchDigest(userId, payload);
      if (cancelled) return;
      aiDigest = d;
    } catch (e) {
      console.warn("portfolio digest:", e);
      // Leave any previously-cached digest on screen; fail silently.
    } finally {
      aiDigestLoading = false;
      if (!cancelled) render();
    }
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

      ${renderDigestCard()}

      ${pendingOrders.length ? renderAmoBanner(pendingOrders) : ""}

      <div class="portfolio-stats">
        <div class="stat-tile"><div class="l">Cash</div><div class="v tabular">${formatRupees(cash, { compact: true })}</div></div>
        <div class="stat-tile"><div class="l">Invested</div><div class="v tabular">${formatRupees(holdValue, { compact: true })}</div></div>
        <div class="stat-tile"><div class="l">Holdings</div><div class="v tabular">${holdings.length}</div></div>
        <div class="stat-tile ${pendingOrders.length ? 'has-pending' : ''}"><div class="l">Queued AMOs</div><div class="v tabular">${pendingOrders.length}</div></div>
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
            <div class="card" id="order-list" style="border: 1px solid color-mix(in srgb, var(--brand) 40%, var(--border));">
              <div class="card-head">
                <h3>
                  <span style="color: var(--brand);">🕗</span>
                  Queued AMOs &amp; Limit orders
                  <span class="pill pill-brand" style="margin-left: 6px; font-size: 11px;">${pendingOrders.length}</span>
                </h3>
              </div>
              <div class="flex-col gap-2">
                ${pendingOrders.map(o => {
                  const inst = getInstrument(o.symbol) || { name: o.symbol };
                  const limitRupees = Number(o.limit_price_paise) / 100;
                  const reserveRupees = o.side === "BUY" ? (Number(o.reserved_cash || 0) / 100) : null;
                  return `
                    <div class="flex items-center justify-between" style="padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface);">
                      <div>
                        <div class="text-md"><span class="pill ${o.side === "BUY" ? "pill-green" : "pill-red"}">${o.side} LIMIT</span> <strong>${escapeHtml(inst.name)}</strong></div>
                        <div class="dim text-xs">${o.qty} × ₹${limitRupees.toFixed(2)} · queued ${timeSince(new Date(o.created_at))} ago${reserveRupees != null ? ` · ₹${reserveRupees.toFixed(2)} reserved` : ""}</div>
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

    // Wire up Cancel buttons on Pending orders. Without this the buttons
    // looked active but did nothing — users assumed the AMO system was
    // broken when they couldn't cancel a queued order.
    main.querySelectorAll("[data-cancel-order]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.cancelOrder;
        if (!id) return;
        btn.disabled = true;
        btn.textContent = "Cancelling…";
        try {
          await cancelOrder(id);
          // Refresh the pending-orders list + portfolio cash (the cancelled
          // order's reserved cash should now be back in the wallet).
          try {
            pendingOrders = await listPendingOrders();
            const { loadAllFromDb } = await import("../db/sync.js");
            await loadAllFromDb();
          } catch {}
          render();
        } catch (e) {
          console.error("[portfolio] cancel order failed:", e);
          btn.disabled = false;
          btn.textContent = "Cancel";
        }
      });
    });
  }

  function renderDigestCard() {
    if (!aiDigest && !aiDigestLoading) return "";
    if (aiDigestLoading && !aiDigest) {
      return `
        <div class="pf-digest-card loading">
          <div class="pf-digest-head"><span class="pf-digest-label">Saathi</span><span class="dim text-xs">reading your portfolio…</span></div>
          <div class="pf-digest-body skeleton" style="height: 48px; border-radius: 6px;"></div>
        </div>
      `;
    }
    const moodClass = `mood-${aiDigest.mood || "flat"}`;
    return `
      <div class="pf-digest-card ${moodClass}">
        <div class="pf-digest-head">
          <span class="pf-digest-label">Saathi</span>
          ${aiDigestLoading ? `<span class="dim text-xs">refreshing…</span>` : ""}
        </div>
        <div class="pf-digest-body">${escapeHtml(aiDigest.narrative)}</div>
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

// Human-readable "X ago" for Pending-orders queued timestamps.
function timeSince(d) {
  const ms = Date.now() - d.getTime();
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Hero-style banner shown above the stat tiles whenever the user has at
// least one pending AMO / limit order. Makes it unmissable that money
// is reserved for an order queued at the next market open — previously
// the pending-orders card was tucked below Holdings and users wondered
// where their cash went after queuing an AMO.
function renderAmoBanner(pendingOrders) {
  const ms = marketStatus();
  const countLabel = `${pendingOrders.length} order${pendingOrders.length > 1 ? "s" : ""}`;
  const buyCount = pendingOrders.filter(o => o.side === "BUY").length;
  const sellCount = pendingOrders.length - buyCount;
  const breakdown = [
    buyCount ? `${buyCount} buy` : null,
    sellCount ? `${sellCount} sell` : null,
  ].filter(Boolean).join(" · ");
  const timingLine = ms.open
    ? "Fills when the market price crosses your limit."
    : `Fills at ${escapeHtml(ms.nextOpenLabel || "the next market open")} at the opening tick.`;
  return `
    <div class="card" style="margin-bottom: var(--sp-4); padding: var(--sp-4); background: color-mix(in srgb, var(--brand) 8%, var(--bg-soft)); border: 1px solid color-mix(in srgb, var(--brand) 38%, var(--border));">
      <div class="flex items-center gap-3 wrap">
        <span style="font-size: 22px;" aria-hidden="true">🕗</span>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; color: var(--text-strong);">${countLabel} queued${breakdown ? ` · ${escapeHtml(breakdown)}` : ""}</div>
          <div class="muted text-xs" style="margin-top: 2px; line-height: 1.5;">${timingLine} Scroll down to review or cancel.</div>
        </div>
        <a href="#order-list" class="btn btn-ghost btn-sm" onclick="document.querySelector('#order-list')?.scrollIntoView({behavior:'smooth'});event.preventDefault();">Jump to orders</a>
      </div>
    </div>
  `;
}
