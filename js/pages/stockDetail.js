// =============================================================================
// STOCK DETAIL — Real price + real history via marketData. Quantity selector
// for buy/sell. Panic-sell intervention before SELL executes.
// =============================================================================

import { getInstrument } from "../data/universe.js";
import { getQuote, getHistory, subscribeToQuotes, quoteAge, getFundamentals, getFreshCachedQuote } from "../data/marketData.js";
import { placeLimitOrder } from "../features/limitOrders.js";
import { buildOrderBook, buildRecentTrades } from "../data/orderBook.js";
import { getSeries, getCloses, getPriceAt, getTodayChange, get52wRange, marketStatus } from "../data/prices.js";
import { candleChart, lineChart, stockChart, attachStockChartHover } from "../components/charts.js";
import { formatRupees, formatPct, deltaClass, formatQty } from "../money.js";
import {
  getState, subscribe, applyTrade, recordCoachMessage, genId, addToWatchlist, removeFromWatchlist,
  getPortfolioValue,
} from "../state.js";
import { coach } from "../coach/orchestrator.js";
import { detectPanicSell } from "../coach/biasDetectors.js";
import { buildAnalogContext } from "../coach/historicalAnalog.js";
import { showInterventionModal } from "../components/interventionModal.js";
import { mountQuantitySelector } from "../components/quantitySelector.js";
import { toast } from "../components/toast.js";
import { termHtml } from "../features/aiExplainer.js";

// Timeframe → Yahoo range/interval. 1D uses 5m intraday so the chart looks
// like Groww's (dense 1-min-ish bars), not a sparse 5-daily-candle bar.
const TF_MAP = {
  "1D": { range: "1d",  interval: "5m",  days: 1   },
  "1W": { range: "5d",  interval: "30m", days: 5   },
  "1M": { range: "1mo", interval: "1d",  days: 22  },
  "3M": { range: "3mo", interval: "1d",  days: 66  },
  "6M": { range: "6mo", interval: "1d",  days: 130 },
  "1Y": { range: "1y",  interval: "1d",  days: 260 },
};
const TF_ORDER = ["1D", "1W", "1M", "3M", "6M", "1Y"];

let ui = {
  side: "BUY", qty: 1,
  timeframe: "1M",
  chartMode: "candle",   // "candle" | "area"
  orderType: "MARKET", limitPrice: 0,
};
let liveQuote = null;
let liveHistory = null;
let liveFundamentals = null;
let qtySelectorHandle = null;
let _cancelToken = { cancelled: false };    // shared per-mount token
let _stockWhyKey = null;                     // "SYMBOL_day" — prevents refire on live-quote refresh
let _stockWhyLast = null;                    // last explanation rendered for this mount

export function renderStockDetail(main, params) {
  const symbol = params.symbol;
  const inst = getInstrument(symbol);
  // Reset the per-mount AI-why memo whenever the viewed symbol changes.
  if (_stockWhyKey && !_stockWhyKey.startsWith(symbol + "_")) {
    _stockWhyKey = null;
    _stockWhyLast = null;
  }
  if (!inst) {
    main.innerHTML = `<div class="empty-state"><span class="emoji">🔍</span><h3>Instrument not found</h3><p>Symbol "${symbol}" isn't in the universe.</p><a href="#/stocks" class="btn btn-primary">Back</a></div>`;
    return;
  }

  // Cancel any previous mount's pending work
  _cancelToken.cancelled = true;
  _cancelToken = { cancelled: false };
  const myToken = _cancelToken;

  ui = {
    side: "BUY",
    qty: inst.kind === "MF" ? 0.5 : 1,
    timeframe: "1M",
    chartMode: "candle",
    orderType: "MARKET", limitPrice: 0,
  };
  liveQuote = null;
  liveHistory = null;
  liveFundamentals = null;
  qtySelectorHandle?.destroy?.();
  qtySelectorHandle = null;

  // Prefill liveQuote ONLY if the cache entry is fresh. This avoids the
  // "flash of stale price" bug where the page used to paint inst.price
  // (the seeded universe price, possibly months old) for 5-15 seconds
  // before the first poll landed. Fresh cache → instant paint with real
  // prices. No fresh cache → render() falls through to the price-block
  // skeleton and waits for the poll.
  const preQuote = inst.kind !== "MF" ? getFreshCachedQuote(symbol) : null;
  if (preQuote) liveQuote = preQuote;

  render(inst, symbol);
  const unsub = subscribe(() => { if (!myToken.cancelled) render(inst, symbol); });
  const pollUnsub = subscribeToQuotes([symbol], (quotes) => {
    if (myToken.cancelled) return;
    if (quotes[symbol]) { liveQuote = quotes[symbol]; render(inst, symbol); }
  }, 12_000);  // 12s refresh on the currently-open stock
  const onLeave = () => { myToken.cancelled = true; unsub?.(); pollUnsub?.(); };
  window.addEventListener("hashchange", onLeave, { once: true });
  // Fetch history
  (async () => {
    try {
      const tf = TF_MAP[ui.timeframe] || TF_MAP["1M"];
      const h = await getHistory(symbol, tf.range, tf.interval);
      if (myToken.cancelled) return;
      if (h) { liveHistory = h; render(inst, symbol); }
    } catch (e) { console.warn("history:", e); }
  })();

  // Fetch fundamentals. This was missing — liveFundamentals was declared
  // but never populated, so the Fundamentals card sat on "Loading…" forever
  // and fell back to universe.js static values + synthetic 52W range.
  (async () => {
    try {
      if (inst.kind === "MF") return;   // MFs don't have per-share fundamentals
      const f = await getFundamentals(symbol);
      if (myToken.cancelled) return;
      if (f) { liveFundamentals = f; render(inst, symbol); }
    } catch (e) { console.warn("fundamentals:", e); }
  })();

  // Stock intro coach (non-blocking, first view only)
  const existing = getState().coachMessages.some(m => m.eventType === "STOCK_INTRO" && m.triggerSymbol === symbol);
  if (!existing) {
    coach({ type: "STOCK_INTRO", symbol, instrument: inst }).then(msg => {
      if (myToken.cancelled) return;
      msg.triggerSymbol = symbol;
      recordCoachMessage(msg);
    });
  }
}

async function reloadHistory(inst, symbol) {
  const myToken = _cancelToken;
  const tf = TF_MAP[ui.timeframe] || TF_MAP["1M"];
  liveHistory = null;
  render(inst, symbol);
  const h = await getHistory(symbol, tf.range, tf.interval).catch(() => null);
  if (myToken.cancelled) return;
  if (h) { liveHistory = h; render(inst, symbol); }
}

function render(inst, symbol) {
  const main = document.getElementById("main");
  const state = getState();
  const holding = state.holdings[symbol];

  // Price-block loading state. Mutual funds don't have a live feed so we
  // never show a skeleton for them. Equities: show a skeleton until the
  // first live (or fresh-cache-prefilled) quote lands — better than
  // flashing the seeded universe price for 5-15 seconds while the poll
  // ticks over.
  const priceLoading = inst.kind !== "MF" && !liveQuote;
  const curPrice = liveQuote?.pricePaise ?? getPriceAt(symbol, 0);
  const change = liveQuote?.changePct ?? getTodayChange(symbol);
  const dayChangeVal = Math.round(curPrice * change);

  const tfSpec = TF_MAP[ui.timeframe] || TF_MAP["1M"];
  const historyLoading = inst.kind !== "MF" && !liveHistory;
  const history = liveHistory?.ohlc?.length ? liveHistory.ohlc : getSeries(symbol).slice(-tfSpec.days);
  const closes = history.map(k => k.c);

  const { hi, lo } = get52wRange(symbol);
  const isWatched = state.watchlist.includes(symbol);

  const dataSource = liveQuote?.source === "yahoo" || liveQuote?.source === "finnhub"
    ? { label: "Live", live: true }
    : { label: "Cached", live: false };
  const ms = marketStatus();

  // ===================================================================
  // After-hours AMO mode — mirror Groww.
  // When NSE is closed, Market orders are disabled. The trade form
  // forces the Limit tab (== AMO) and pre-fills with the last-shown
  // price so the user can one-tap queue an order that fills at the
  // next market open. This also bypasses the apply_trade RPC hang that
  // happens out-of-hours by routing through placeLimitOrder() instead.
  // ===================================================================
  if (!ms.open) {
    if (ui.orderType !== "LIMIT") ui.orderType = "LIMIT";
    if (!ui.limitPrice || +ui.limitPrice <= 0) {
      ui.limitPrice = (curPrice / 100).toFixed(2);
    }
  }

  main.innerHTML = `
    <div style="margin-bottom: var(--sp-5);">
      <div class="flex items-center gap-2">
        <a href="#/stocks" class="btn btn-ghost btn-sm">← Markets</a>
        <span class="dim">/</span>
        <span class="dim text-sm">${escapeHtml(inst.sector)}</span>
      </div>
    </div>

    <div class="stock-detail-grid">
      <div>
        <div class="flex items-start justify-between wrap gap-3">
          <div class="flex items-center gap-3">
            <div class="stock-avatar" style="width: 52px; height: 52px; font-size: 13px;">${escapeHtml(inst.logo || symbol.slice(0, 3))}</div>
            <div>
              <h1 style="font-size: var(--text-2xl); margin-bottom: 2px;">${escapeHtml(inst.name)}</h1>
              <div class="dim text-xs">
                ${symbol} · ${inst.kind === "MF" ? "Mutual Fund" : "NSE"} · ${escapeHtml(inst.sector)}
                <span class="data-badge market-status" tabindex="0" style="margin-left: 8px; position: relative;" data-ms-state="${ms.state}">
                  <span class="dot ${ms.open ? "" : ms.state === "pre-open" ? "preopen" : "closed"}"></span>
                  NSE · ${ms.state === "open" ? "Live" : ms.state === "pre-open" ? "Pre-open" : "Closed"}${ms.state !== "open" ? " · " + escapeHtml(ms.istTime) : ""}
                  <div class="market-status-pop" role="tooltip">
                    <div class="ms-pop-head">
                      <span class="ms-pop-label">NSE · ${ms.state === "open" ? "Live" : ms.state === "pre-open" ? "Pre-open" : "Closed"}</span>
                    </div>
                    <div class="ms-pop-row"><span class="ms-pop-key">Now</span><span>${escapeHtml(ms.istDate)} · ${escapeHtml(ms.istTime)}</span></div>
                    ${ms.state === "open"
                      ? `<div class="ms-pop-row"><span class="ms-pop-key">Closes</span><span>3:30 PM IST today</span></div>`
                      : `<div class="ms-pop-row"><span class="ms-pop-key">${ms.state === "pre-open" ? "Opens" : "Last close"}</span><span>${ms.state === "pre-open" ? "9:15 AM IST today" : escapeHtml(ms.lastCloseLabel || "—")}</span></div>`
                    }
                    ${ms.state !== "open" && ms.nextOpenLabel ? `<div class="ms-pop-row"><span class="ms-pop-key">Next open</span><span>${escapeHtml(ms.nextOpenLabel)}</span></div>` : ""}
                    ${ms.isHoliday ? `<div class="ms-pop-row"><span class="ms-pop-key">Holiday</span><span>Yes</span></div>` : ""}
                    <div class="ms-pop-row"><span class="ms-pop-key">Hours</span><span>Mon–Fri · 9:15 AM – 3:30 PM IST</span></div>
                    <div class="ms-pop-foot">Clock is server-trusted. Changing your system time won't move it.</div>
                  </div>
                </span>
              </div>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm watch-btn">${isWatched ? "★ Watching" : "☆ Watchlist"}</button>
        </div>

        <div class="price-block" style="margin-top: var(--sp-4);">
          ${priceLoading ? `
            <div class="skeleton" style="width: 180px; height: 40px;" aria-label="Loading price"></div>
            <div class="skeleton" style="width: 200px; height: 18px;" aria-label="Loading change"></div>
          ` : `
            <div class="price tabular">${formatRupees(curPrice)}</div>
            <div class="change ${deltaClass(change)} tabular">
              ${formatRupees(dayChangeVal, { sign: true })} (${formatPct(change, { sign: true })}) today
            </div>
          `}
        </div>

        <div class="tf-buttons" style="display:flex; align-items:center; gap:var(--sp-2); flex-wrap:wrap;">
          <div style="display:flex; gap:4px;">
            ${TF_ORDER.map(tf => `<button class="tf-btn ${ui.timeframe === tf ? "active" : ""}" data-tf="${tf}">${tf}</button>`).join("")}
          </div>
          ${inst.kind !== "MF" ? `
            <div class="chart-mode-toggle" style="margin-left:auto; display:flex; gap:2px; background:var(--bg-soft); border:1px solid var(--border); border-radius:var(--r-sm); padding:2px;">
              <button class="chart-mode-btn ${ui.chartMode === "candle" ? "active" : ""}" data-mode="candle" aria-label="Candlestick" title="Candlestick view" style="border:0; background:${ui.chartMode === "candle" ? "var(--surface)" : "transparent"}; color:${ui.chartMode === "candle" ? "var(--text-strong)" : "var(--text-muted)"}; padding:4px 10px; border-radius:calc(var(--r-sm) - 2px); cursor:pointer; font-size:var(--text-xs); display:flex; align-items:center; gap:4px;">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="3" y="3" width="2" height="8" fill="currentColor" opacity="0.9"/><line x1="4" y1="1" x2="4" y2="13" stroke="currentColor" stroke-width="1"/><rect x="9" y="5" width="2" height="5" fill="currentColor" opacity="0.9"/><line x1="10" y1="3" x2="10" y2="12" stroke="currentColor" stroke-width="1"/></svg>
                Candle
              </button>
              <button class="chart-mode-btn ${ui.chartMode === "area" ? "active" : ""}" data-mode="area" aria-label="Area line" title="Area / line view" style="border:0; background:${ui.chartMode === "area" ? "var(--surface)" : "transparent"}; color:${ui.chartMode === "area" ? "var(--text-strong)" : "var(--text-muted)"}; padding:4px 10px; border-radius:calc(var(--r-sm) - 2px); cursor:pointer; font-size:var(--text-xs); display:flex; align-items:center; gap:4px;">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 10 L4 6 L7 8 L10 3 L13 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>
                Line
              </button>
            </div>
          ` : ""}
        </div>

        <div class="card" style="padding: var(--sp-3);">
          ${historyLoading ? `
            <div id="stock-chart-host" style="height: clamp(260px, 44vh, 360px); width: 100%; display:grid; place-items:center; gap:var(--sp-3);">
              <div class="skeleton" style="width: 100%; height: 75%;" aria-label="Loading chart"></div>
              <div class="dim text-xs">Loading ${ui.timeframe} chart…</div>
            </div>
          ` : inst.kind === "MF"
            ? `<div style="height: 300px;">${lineChart(closes, { height: 300, color: "var(--brand)" })}</div>`
            : `<div id="stock-chart-host" style="height: clamp(260px, 44vh, 360px); width: 100%;">${stockChart(history, { height: 360, mode: ui.chartMode, width: (typeof window !== "undefined" && window.innerWidth < 640) ? 440 : 800 })}</div>`}
        </div>

        <div class="card stock-why-card" id="stock-why-card" style="margin-top: var(--sp-4);">
          <div class="card-head">
            <h3><span class="pf-digest-label">Saathi</span> Why is this moving today?</h3>
          </div>
          <div id="stock-why-body" class="muted">Reading today's news + price action…</div>
        </div>

        ${inst.kind !== "MF" ? renderOrderBook(symbol, curPrice) : ""}

        <div class="card" style="margin-top: var(--sp-4);">
          <div class="card-head">
            <h3>Fundamentals</h3>
            ${liveFundamentals ? `<span class="data-badge"><span class="dot"></span> NSE</span>` : `<span class="data-badge"><span class="dot offline"></span> Loading…</span>`}
          </div>
          <div class="fundamentals">
            ${renderFundamentals(inst, liveFundamentals, hi, lo)}
          </div>
        </div>
      </div>

      <aside>
        <div class="card trade-box">
          ${!ms.open ? `
            <div class="amo-banner" style="margin-bottom: var(--sp-3); padding: var(--sp-3); border-radius: var(--r-md); background: color-mix(in srgb, var(--brand) 7%, var(--bg-soft)); border: 1px solid color-mix(in srgb, var(--brand) 35%, var(--border)); font-size: var(--text-xs); line-height: 1.45;">
              <div style="font-weight: 600; color: var(--text-strong); margin-bottom: 2px;">🕗 NSE Closed — AMO mode</div>
              <div class="dim">Your order queues now and executes at <strong style="color: var(--text-strong);">${escapeHtml(ms.nextOpenLabel || "the next market open")}</strong> at the opening price. Market orders are unavailable after hours (same behaviour as Groww).</div>
            </div>
          ` : ""}

          <div class="trade-tabs">
            <button class="trade-tab buy ${ui.side === "BUY" ? "active" : ""}" data-side="BUY">Buy</button>
            <button class="trade-tab sell ${ui.side === "SELL" ? "active" : ""}" data-side="SELL">Sell</button>
          </div>

          <div class="lb-tabs" style="margin-bottom: var(--sp-3); width: 100%;">
            <button class="lb-tab ${ui.orderType === "MARKET" ? "active" : ""}" data-otype="MARKET" style="flex: 1;${!ms.open ? " opacity: 0.45; cursor: not-allowed;" : ""}"
              ${!ms.open ? `disabled title="Market orders unavailable after hours — use Limit to queue an AMO."` : ""}>
              Market${!ms.open ? " 🔒" : ""}
            </button>
            <button class="lb-tab ${ui.orderType === "LIMIT" ? "active" : ""}" data-otype="LIMIT" style="flex: 1;">${!ms.open ? "Limit (AMO)" : "Limit"}</button>
          </div>

          ${ui.orderType === "LIMIT" ? `
            <div style="margin-bottom: var(--sp-3);">
              <label class="label" for="limit-price-input">${!ms.open ? "AMO price (₹)" : "Limit price (₹)"}</label>
              <input class="input" id="limit-price-input" type="number" min="0.01" step="0.05"
                placeholder="${(curPrice/100).toFixed(2)}"
                value="${ui.limitPrice || (curPrice/100).toFixed(2)}" inputmode="decimal" />
              <div class="dim text-xs" style="margin-top: 4px;">
                ${!ms.open
                  ? `Fills at market open when the opening tick crosses ${ui.side === "BUY" ? "at or below" : "at or above"} this price. Pre-filled with the last close — edit if you want a stricter fill.`
                  : ui.side === "BUY"
                    ? "Fires when market price drops to this level or lower."
                    : "Fires when market price rises to this level or higher."}
              </div>
            </div>
          ` : ""}

          ${holding ? `
            <div class="pill pill-brand" style="margin-bottom: var(--sp-3); font-size: var(--text-xs);">
              Holding: ${formatQty(holding.qty, inst.kind)} @ ${formatRupees(holding.avgCostPaise)} avg
            </div>
          ` : (ui.side === "SELL" ? `
            <div class="info-msg" style="margin-bottom: var(--sp-3); font-size: var(--text-xs);">You don't hold this. Buy some first.</div>
          ` : "")}

          <div id="qty-container"></div>

          <div class="order-summary">
            <div class="row"><span>Price</span><span class="num">${formatRupees(curPrice)}</span></div>
            <div class="row"><span>Qty</span><span class="num" id="os-qty">${formatQty(ui.qty, inst.kind)}</span></div>
            <div class="row total"><span>Estimated ${ui.side === "BUY" ? "cost" : "proceeds"}</span><span class="num" id="os-total">${formatRupees(Math.round(ui.qty * curPrice))}</span></div>
          </div>

          <button class="btn btn-block ${ui.side === "BUY" ? "btn-buy" : "btn-sell"}" id="place-trade-btn"
            ${ui.side === "SELL" && !holding ? "disabled" : ""}>
            ${!ms.open
              ? `Queue AMO ${ui.side === "BUY" ? "Buy" : "Sell"}`
              : ui.orderType === "LIMIT"
                ? `Place ${ui.side === "BUY" ? "Buy" : "Sell"} limit`
                : `Review ${ui.side === "BUY" ? "Buy" : "Sell"} order`}
          </button>

          ${ui.side === "SELL" && !holding ? `
            <div class="dim text-xs center" style="margin-top: var(--sp-3); color: var(--warning, var(--text-muted));">
              You don't hold any ${inst.symbol} to sell. Switch to Buy, or pick a stock from your portfolio.
            </div>
          ` : `
            <div class="dim text-xs center" style="margin-top: var(--sp-3);">
              ${!ms.open
                ? `Virtual money · Queues as AMO · Fills at ${escapeHtml(ms.nextOpenLabel || "next market open")}`
                : "Virtual money · Reviewed on a confirmation step · Coach reflection follows every trade"}
            </div>
          `}
        </div>
      </aside>
    </div>
  `;

  // Paint the cached Saathi take if we already generated one this mount
  const whyBody = main.querySelector("#stock-why-body");
  if (whyBody) {
    if (_stockWhyLast) {
      whyBody.classList.remove("muted");
      whyBody.textContent = _stockWhyLast;
    } else {
      // Fire once per (symbol, day) at module scope
      const dk = nowIstDayKey();
      const key = `${symbol}_${dk}`;
      if (_stockWhyKey !== key) {
        _stockWhyKey = key;
        fetchStockWhy(main, symbol, inst, curPrice, liveQuote?.changePct ?? 0);
      }
    }
  }

  // Mount quantity selector
  const qtyContainer = main.querySelector("#qty-container");
  if (qtyContainer) {
    qtySelectorHandle?.destroy?.();
    qtySelectorHandle = mountQuantitySelector(qtyContainer, {
      side: ui.side,
      kind: inst.kind,
      pricePaise: curPrice,
      cashPaise: state.portfolio.cashPaise,
      holdingQty: holding?.qty || 0,
      initialQty: ui.qty,
      onChange: (qty) => {
        ui.qty = qty;
        const qtyEl = main.querySelector("#os-qty");
        const totalEl = main.querySelector("#os-total");
        if (qtyEl) qtyEl.textContent = formatQty(qty, inst.kind);
        if (totalEl) totalEl.textContent = formatRupees(Math.round(qty * curPrice));
      },
    });
  }

  attachListeners(main, inst, symbol, curPrice, holding);
}

function nowIstDayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function fetchStockWhy(main, symbol, inst, curPricePaise, changePct) {
  try {
    // Pull a few recent news items for this symbol to give the model
    // real grounding instead of speculation.
    const { getNews } = await import("../data/news.js");
    let newsItems = [];
    try {
      newsItems = await getNews({ limit: 10, filterSymbols: [symbol] });
    } catch {}
    if (!newsItems || newsItems.length === 0) {
      try { newsItems = await getNews({ limit: 6 }); } catch {}
    }
    const payload = {
      symbol,
      name: inst?.name || symbol,
      sector: inst?.sector || "",
      pricePaise: curPricePaise,
      changePct: (changePct || 0) * 100,
      newsItems: (newsItems || []).slice(0, 8).map(n => ({ headline: n.headline, source: n.source })),
    };
    const r = await fetch("/api/ai?op=stock-why", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`http_${r.status}`);
    const d = await r.json();
    if (!d?.explanation) throw new Error("no_explanation");
    _stockWhyLast = d.explanation;
    const el = main?.querySelector("#stock-why-body");
    if (el) {
      el.classList.remove("muted");
      el.textContent = d.explanation;
    }
  } catch (e) {
    _stockWhyLast = null;
    const el = main?.querySelector("#stock-why-body");
    if (el) {
      el.classList.add("dim");
      el.textContent = "Couldn't read today's drivers right now. Refresh the page in a bit to retry.";
    }
  }
}

function attachListeners(main, inst, symbol, curPrice, holding) {
  main.querySelectorAll(".tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.timeframe = btn.dataset.tf;
      reloadHistory(inst, symbol);
    });
  });
  // Candle/Line mode toggle — no refetch, just re-render with other mode.
  main.querySelectorAll(".chart-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.chartMode = btn.dataset.mode;
      render(inst, symbol);
    });
  });
  // Attach hover crosshair + tooltip (re-called on every render). Skip for
  // MFs which use the simpler lineChart (no OHLC data available). Also
  // skip while the chart-host is showing the loading skeleton — there's
  // no SVG inside it to hang hover events off, and we don't want to
  // attach hover to seeded history the user doesn't actually see.
  if (inst.kind !== "MF" && liveHistory?.ohlc?.length) {
    const host = main.querySelector("#stock-chart-host");
    if (host && host.querySelector(".chart-svg")) {
      attachStockChartHover(host, liveHistory.ohlc, { mode: ui.chartMode });
    }
  }

  main.querySelectorAll("[data-side]").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.side = btn.dataset.side;
      ui.qty = inst.kind === "MF" ? 0.5 : 1;
      render(inst, symbol);
    });
  });

  main.querySelectorAll("[data-otype]").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.orderType = btn.dataset.otype;
      if (ui.orderType === "LIMIT" && !ui.limitPrice) ui.limitPrice = (curPrice / 100).toFixed(2);
      render(inst, symbol);
    });
  });

  const limitInput = main.querySelector("#limit-price-input");
  if (limitInput) {
    limitInput.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v) && v > 0) ui.limitPrice = v;
    });
  }

  main.querySelector(".watch-btn")?.addEventListener("click", () => {
    if (getState().watchlist.includes(symbol)) removeFromWatchlist(symbol);
    else addToWatchlist(symbol);
  });

  main.querySelector("#place-trade-btn")?.addEventListener("click", async () => {
    // Wrap in try/catch so any silent throw inside reviewTrade surfaces
    // as a visible toast instead of the button appearing "dead".
    try {
      console.log("[trade] click on place-trade-btn", { side: ui.side, qty: ui.qty, symbol });
      await reviewTrade(inst, symbol, curPrice, holding);
    } catch (e) {
      console.error("[trade] reviewTrade threw:", e);
      toast({ kind: "error", message: e?.message || "Trade review failed. Check console." });
    }
  });
}

async function reviewTrade(inst, symbol, curPrice, holding) {
  const qty = qtySelectorHandle?.get?.() ?? ui.qty;
  if (!qty || qty <= 0) { toast({ kind: "error", message: "Enter a valid quantity." }); return; }
  if (ui.side === "SELL" && (!holding || holding.qty < qty - 1e-9)) {
    toast({ kind: "error", message: `You only hold ${holding?.qty || 0}.` });
    return;
  }

  // ---- After-hours AMO path --------------------------------------------
  // Mirror Groww: when NSE is closed, we never call apply_trade — we queue
  // the order as a limit at the last-shown price, and the existing
  // limit-order matcher fills it at the first tick after market open
  // (which is mathematically the same as an AMO fill at the opening price).
  // This also sidesteps the apply_trade RPC hang that happens out-of-hours.
  const ms = marketStatus();
  if (!ms.open) {
    const fallbackRupees = curPrice / 100;
    const limitRupees = Number.isFinite(parseFloat(ui.limitPrice)) && parseFloat(ui.limitPrice) > 0
      ? parseFloat(ui.limitPrice)
      : fallbackRupees;
    const limitPaise = Math.round(limitRupees * 100);
    if (!Number.isFinite(limitPaise) || limitPaise <= 0) {
      toast({ kind: "error", message: "Couldn't read the AMO price. Edit the limit price field and try again." });
      return;
    }
    if (ui.side === "BUY" && Math.round(qty * limitPaise) > (getState().portfolio?.cashPaise || 0)) {
      toast({ kind: "error", message: "Not enough cash to reserve for this AMO." });
      return;
    }
    // Disable the button + show "Queuing…" so the user gets instant
    // feedback that their tap landed — previously a slow Supabase round
    // trip left the button looking dead for 1-3 seconds.
    const btn = document.getElementById("place-trade-btn");
    const originalLabel = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Queuing AMO…"; }
    try {
      console.log("[AMO] placing", { symbol, side: ui.side, qty, limitPaise });
      const res = await placeLimitOrder({ symbol, side: ui.side, qty, limitPricePaise: limitPaise });
      console.log("[AMO] placed", res);
      toast({
        kind: "success",
        message: `AMO queued: ${ui.side} ${formatQty(qty, inst.kind)} ${symbol} @ ₹${limitRupees.toFixed(2)}. Fills at ${ms.nextOpenLabel || "next market open"}.`,
        duration: 5000,
      });
      // Refresh local state from DB so the user sees the cash reservation
      // reflected in the UI (portfolio cashPaise drops by the reserve
      // amount). Without this, the page still shows full cash and the
      // user thinks nothing happened. Best-effort — don't block the nav.
      try {
        const { loadAllFromDb } = await import("../db/sync.js");
        await loadAllFromDb();
      } catch (syncErr) {
        console.warn("[AMO] post-queue sync failed (non-critical):", syncErr);
      }
      // Navigate to portfolio so the queued order is visible in the
      // "Pending limit orders" card — gives the user concrete evidence
      // the AMO landed, not just a toast.
      location.hash = "#/portfolio";
    } catch (e) {
      console.error("[AMO] placeLimitOrder failed:", e);
      toast({
        kind: "error",
        message: e?.message || "Could not queue AMO. Check console for details.",
        duration: 6000,
      });
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    }
    return;
  }

  // ---- Limit order path — DB RPC reserves cash and records order --------
  if (ui.orderType === "LIMIT") {
    const limitRupees = parseFloat(ui.limitPrice);
    if (!Number.isFinite(limitRupees) || limitRupees <= 0) {
      toast({ kind: "error", message: "Enter a valid limit price." });
      return;
    }
    const limitPaise = Math.round(limitRupees * 100);
    // Basic UX sanity: BUY limit above current price or SELL limit below
    // current price would fire immediately — still valid, but warn once.
    const wouldFireNow =
      (ui.side === "BUY" && curPrice <= limitPaise) ||
      (ui.side === "SELL" && curPrice >= limitPaise);
    if (wouldFireNow && !confirm(`Your limit is already ${ui.side === "BUY" ? "above" : "below"} the market (${formatRupees(curPrice)}). The order will fill immediately. Continue?`)) {
      return;
    }
    try {
      await placeLimitOrder({ symbol, side: ui.side, qty, limitPricePaise: limitPaise });
      toast({ kind: "success", message: `${ui.side} limit placed: ${formatQty(qty, inst.kind)} ${symbol} @ ₹${limitRupees.toFixed(2)}. Fills automatically when market crosses.` });
    } catch (e) {
      toast({ kind: "error", message: e.message || "Could not place limit order." });
    }
    return;
  }

  // ---- Market order path — existing flow --------------------------------
  if (ui.side === "BUY" && Math.round(qty * curPrice) > getState().portfolio.cashPaise) {
    toast({ kind: "error", message: "Not enough cash." });
    return;
  }

  // SELL → check panic detector FIRST (before confirmation modal)
  if (ui.side === "SELL" && holding) {
    const biasResult = detectPanicSell({
      trade: { symbol, side: "SELL", qty, pricePaise: curPrice },
      holding,
    });
    if (biasResult && biasResult.severity >= 0.35) {
      const analog = buildAnalogContext(symbol);
      showInterventionModal(
        { analog, biasResult, instrument: inst, trade: { qty, pricePaise: curPrice, holding } },
        {
          onProceed: () => showConfirm(inst, symbol, curPrice, qty, biasResult),
          onHold: () => {
            toast({ kind: "info", message: "Held. Good choice to pause." });
            recordCoachMessage({
              id: genId(), ts: Date.now(),
              eventType: "INTERVENTION_HOLD",
              triggerSymbol: symbol,
              model: "template",
              payload: {
                reflection: `You paused a panic-sell on ${inst.name}. Doing nothing in the middle of a drop is the rarest skill in investing. The muscle you just used is the one that actually matters long-term.`,
                historical_context: analog ? `Median recovery for dips of this size on ${inst.name}: ${analog.recoveryDays} trading days (n=${analog.sampleSize}).` : null,
                warning_level: "info",
                suggested_q: "Set a rule right now — if this drops another 5%, what will you do? Write it down.",
                citations: ["hold_decision", "panic_averted"],
              },
              biases: [biasResult],
            });
          },
        }
      );
      return;
    }
  }

  showConfirm(inst, symbol, curPrice, qty, null);
}

function showConfirm(inst, symbol, curPrice, qty, biasResult) {
  const modalRoot = document.getElementById("modal-root");
  const total = Math.round(qty * curPrice);
  const side = ui.side;

  modalRoot.innerHTML = `
    <div class="modal-overlay" id="confirm-overlay" role="dialog" aria-modal="true">
      <div class="modal" style="max-width: 440px;">
        <div class="modal-head">
          <div class="modal-icon ${side === "BUY" ? "success" : "warn"}">${side === "BUY" ? "✓" : "↓"}</div>
          <div>
            <div class="text-xs uppercase font-bold" style="color: ${side === "BUY" ? "var(--positive)" : "var(--negative)"};">${side} order</div>
            <h2>Confirm your ${side.toLowerCase()}</h2>
          </div>
        </div>
        <div class="modal-body">
          <div class="intervention-data">
            <div class="flex items-center justify-between">
              <div>
                <div class="dim text-xs uppercase">Instrument</div>
                <div class="font-semi" style="color: var(--text-strong);">${escapeHtml(inst.name)}</div>
                <div class="dim text-xs">${symbol}</div>
              </div>
              <div class="right">
                <div class="dim text-xs uppercase">Qty × Price</div>
                <div class="font-mono font-bold" style="color: var(--text-strong);">${formatQty(qty, inst.kind)} × ${formatRupees(curPrice)}</div>
              </div>
            </div>
            <div style="margin-top: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--border);">
              <div class="flex items-center justify-between">
                <span class="dim text-xs uppercase">${side === "BUY" ? "Total cost" : "Total proceeds"}</span>
                <span class="font-mono font-bold" style="font-size: var(--text-xl); color: ${side === "BUY" ? "var(--negative)" : "var(--positive)"};">
                  ${side === "BUY" ? "−" : "+"}${formatRupees(total)}
                </span>
              </div>
            </div>
          </div>
          <div id="trade-nudge-slot" class="trade-nudge-slot loading">
            <span class="pf-digest-label">Saathi</span>
            <span class="trade-nudge-body dim">looking at your portfolio…</span>
          </div>
          <p class="text-xs dim" style="text-align: center;">Virtual money. Order executes at ${formatRupees(curPrice)}. Coach reflection follows.</p>
        </div>
        <div class="modal-foot">
          <button class="btn btn-outline" id="cancel-btn">Cancel</button>
          <button class="btn ${side === "BUY" ? "btn-buy" : "btn-sell"}" id="confirm-btn">Confirm ${side}</button>
        </div>
      </div>
    </div>
  `;

  const overlay = modalRoot.querySelector("#confirm-overlay");
  const close = () => { modalRoot.innerHTML = ""; };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  modalRoot.querySelector("#cancel-btn").addEventListener("click", close);
  modalRoot.querySelector("#confirm-btn").addEventListener("click", () => {
    close();
    executeTrade(inst, side, qty, curPrice, biasResult);
  });
  setTimeout(() => modalRoot.querySelector("#confirm-btn")?.focus(), 50);
  // Fire the pre-trade AI nudge in parallel — doesn't block the confirm button.
  fetchTradeNudge(modalRoot, inst, symbol, side, qty, curPrice).catch(() => {});
}

async function fetchTradeNudge(modalRoot, inst, symbol, side, qty, curPricePaise) {
  const state = getState();
  const portfolioPaise = getPortfolioValue ? getPortfolioValue(state) : 0;
  const holding = state.holdings?.[symbol];
  const existingAvgRupees = holding ? holding.avgCostPaise / 100 : null;
  const existingPlPct = holding ? (curPricePaise - holding.avgCostPaise) / holding.avgCostPaise : null;
  // Sector allocation
  let sectorValue = 0;
  if (inst?.sector) {
    for (const [sym, h] of Object.entries(state.holdings || {})) {
      const si = getInstrument(sym);
      if (si?.sector === inst.sector) {
        sectorValue += h.qty * (h.avgCostPaise || 0);
      }
    }
  }
  const totalTradeCountInSymbol = (state.transactions || []).filter(t => t.symbol === symbol).length;

  try {
    const res = await fetch("/api/ai?op=trade-nudge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: side,
        symbol,
        name: inst?.name || "",
        sector: inst?.sector || "",
        qty,
        priceRupees: curPricePaise / 100,
        portfolio: {
          totalRupees: portfolioPaise / 100,
          cashRupees: state.portfolio.cashPaise / 100,
          existingQty: holding?.qty || 0,
          existingAvgRupees,
          existingPlPct,
          tradeCountInSymbol: totalTradeCountInSymbol,
          totalTradeCount: (state.transactions || []).length,
          sectorAllocPct: portfolioPaise ? (sectorValue / portfolioPaise) * 100 : 0,
        },
      }),
    });
    if (!res.ok) throw new Error("http_" + res.status);
    const d = await res.json();
    if (!d?.nudge) throw new Error("no_nudge");
    const slot = modalRoot.querySelector("#trade-nudge-slot");
    if (slot) {
      slot.classList.remove("loading");
      slot.classList.add(`sev-${d.severity || "neutral"}`);
      slot.querySelector(".trade-nudge-body")?.classList?.remove("dim");
      slot.querySelector(".trade-nudge-body").textContent = d.nudge;
    }
  } catch {
    // Modal might already be closed; silently ignore.
    const slot = modalRoot.querySelector("#trade-nudge-slot");
    if (slot) slot.remove();
  }
}

async function executeTrade(inst, side, qty, pricePaise, biasResult) {
  // Simulate real-market execution: routing → match → fill, with small
  // slippage (±0.08%) so prices feel like real fills, not simulator magic.
  try {
    toast({ kind: "info", message: `Routing ${side.toLowerCase()} order…`, duration: 900 });
    // Simulate exchange latency + matching
    await new Promise(r => setTimeout(r, 400 + Math.random() * 500));

    // Fetch fresh live quote at execution moment (may have ticked since review)
    let fillPrice = pricePaise;
    try {
      const q = await getQuote(inst.symbol);
      if (q && !q.stale) fillPrice = q.pricePaise;
    } catch {}

    // Realistic market slippage — BUY usually pays a hair above, SELL gets a
    // hair below the mid. Max ±0.08% for liquid names.
    const slipBps = (Math.random() * 8);
    const slipFactor = side === "BUY" ? (1 + slipBps / 10000) : (1 - slipBps / 10000);
    fillPrice = Math.round(fillPrice * slipFactor);

    const idempotencyKey = `${Date.now()}_${inst.symbol}_${side}_${qty}_${Math.random()}`;
    const txn = await applyTrade({
      symbol: inst.symbol, side, qty, pricePaise: fillPrice, idempotencyKey,
      biasFlags: biasResult ? [biasResult] : [],
    });

    const slipText = slipBps > 0
      ? ` (slippage ${side === "BUY" ? "+" : "−"}${(slipBps).toFixed(1)}bps)`
      : "";
    toast({
      kind: "success",
      message: `Filled: ${side === "BUY" ? "Bought" : "Sold"} ${formatQty(qty, inst.kind)} ${inst.symbol} @ ${formatRupees(fillPrice)}${slipText}`,
      duration: 4500,
    });

    const state = getState();
    const isFirstTrade = state.transactions.length === 1;
    const msg = await coach({ type: side, symbol: inst.symbol, qty, pricePaise: fillPrice, txnId: txn?.id, isFirstTrade });
    recordCoachMessage(msg);
  } catch (e) {
    toast({ kind: "error", message: e.message || "Trade failed" });
    console.error(e);
  }
}

function fundRow(l, v, html = false) {
  return `<div class="item"><div class="l">${l}</div><div class="v">${html ? v : escapeHtml(v)}</div></div>`;
}

function fmtMarketCap(v) {
  if (v == null) return "—";
  // v is in absolute INR
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} L Cr`;
  if (v >= 1e7)  return `${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5)  return `${(v / 1e5).toFixed(2)} L`;
  return v.toLocaleString("en-IN");
}

function renderFundamentals(inst, live, hi52, lo52) {
  // Prefer live values when available, else fall back to seeded universe data
  const mcap = live?.market_cap ? fmtMarketCap(live.market_cap) : (inst.marketCap || "—");
  const pe = live?.pe_ratio != null ? live.pe_ratio.toFixed(2) : (inst.pe != null ? inst.pe.toString() : "—");
  const pb = live?.pb_ratio != null ? live.pb_ratio.toFixed(2) : (inst.pb != null ? inst.pb.toString() : "—");
  const beta = live?.beta != null ? live.beta.toFixed(2) : (inst.beta != null ? inst.beta.toString() : "—");
  const dy = live?.dividend_yield != null
    ? `${(live.dividend_yield * 100).toFixed(2)}%`
    : (inst.divYield != null ? `${inst.divYield}%` : "—");
  const hi = live?.fifty_two_week_high != null
    ? `₹${live.fifty_two_week_high.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
    : formatRupees(hi52);
  const lo = live?.fifty_two_week_low != null
    ? `₹${live.fifty_two_week_low.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
    : formatRupees(lo52);
  const eps = live?.eps != null ? `₹${live.eps.toFixed(2)}` : null;
  const fma = live?.fifty_day_average != null ? `₹${live.fifty_day_average.toFixed(2)}` : null;
  const tma = live?.two_hundred_day_average != null ? `₹${live.two_hundred_day_average.toFixed(2)}` : null;

  return [
    fundRow(termHtml("Market Cap"), mcap),
    fundRow(termHtml("P/E Ratio"), pe),
    fundRow(termHtml("P/B Ratio"), pb),
    fundRow(termHtml("Dividend Yield", "Div Yield"), dy),
    fundRow(termHtml("Beta"), beta),
    fundRow(termHtml("52-week high", "52W High"), hi),
    fundRow(termHtml("52-week low", "52W Low"), lo),
    eps ? fundRow(termHtml("EPS", "EPS (TTM)"), eps) : "",
    fma ? fundRow(termHtml("50-day moving average", "50-day avg"), fma) : "",
    tma ? fundRow(termHtml("200-day moving average", "200-day avg"), tma) : "",
    fundRow(termHtml("Risk tier"), `<span class="risk-pill ${inst.risk}">${inst.risk.toUpperCase()}</span>`, true),
    inst.kind === "MF" ? fundRow(termHtml("Expense Ratio"), `${inst.expenseRatio}%`) : "",
    inst.kind === "MF" ? fundRow(termHtml("AUM"), inst.aum) : "",
  ].filter(Boolean).join("");
}

function renderOrderBook(symbol, curPrice) {
  const ob = buildOrderBook(symbol, curPrice, 5);
  const trades = buildRecentTrades(symbol, curPrice, 8);
  if (!ob.bids.length) return "";
  const fmt = p => "₹" + (p / 100).toFixed(2);
  const nowAgo = ts => {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
  };
  return `
    <div class="card" style="margin-top: var(--sp-4);">
      <div class="card-head">
        <h3>Order book <span class="pill pill-yellow" style="font-size:10px; margin-left:6px; vertical-align:middle;" title="Real NSE market depth requires a paid data feed (Dhan/TrueData). This book + trades are synthesised around the live LTP — useful for teaching the concept, not actual tradeable queue positions.">SIMULATED</span></h3>
        <span class="data-badge"><span class="dot"></span> Spread ${fmt(ob.spread)}</span>
      </div>
      <div class="grid" style="grid-template-columns: 1fr 1fr; gap: var(--sp-4);">
        <div>
          <div class="text-xs uppercase muted" style="margin-bottom: var(--sp-2); color: var(--positive);">Bids (buy orders)</div>
          <div class="table-wrap">
            <table class="table" style="font-size: var(--text-sm);">
              <thead><tr><th class="num">Qty</th><th class="num">Price</th></tr></thead>
              <tbody>
                ${ob.bids.map(b => `
                  <tr><td class="num">${b.qty.toLocaleString("en-IN")}</td>
                      <td class="num up">${fmt(b.price)}</td></tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <div class="text-xs uppercase muted" style="margin-bottom: var(--sp-2); color: var(--negative);">Asks (sell orders)</div>
          <div class="table-wrap">
            <table class="table" style="font-size: var(--text-sm);">
              <thead><tr><th class="num">Price</th><th class="num">Qty</th></tr></thead>
              <tbody>
                ${ob.asks.map(a => `
                  <tr><td class="num down">${fmt(a.price)}</td>
                      <td class="num">${a.qty.toLocaleString("en-IN")}</td></tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div style="margin-top: var(--sp-4);">
        <div class="text-xs uppercase muted" style="margin-bottom: var(--sp-2);">Recent trades <span class="dim" style="text-transform:none; font-weight:400;">(simulated)</span></div>
        <div class="table-wrap">
          <table class="table" style="font-size: var(--text-sm);">
            <thead><tr><th>When</th><th>Side</th><th class="num">Qty</th><th class="num">Price</th></tr></thead>
            <tbody>
              ${trades.map(t => `
                <tr>
                  <td class="dim">${nowAgo(t.ts)} ago</td>
                  <td><span class="pill ${t.side === "BUY" ? "pill-green" : "pill-red"}" style="font-size: 10px;">${t.side}</span></td>
                  <td class="num">${t.qty}</td>
                  <td class="num">${fmt(t.price)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
