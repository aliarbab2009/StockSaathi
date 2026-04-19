// =============================================================================
// STOCK DETAIL — Real price + real history via marketData. Quantity selector
// for buy/sell. Panic-sell intervention before SELL executes.
// =============================================================================

import { getInstrument } from "../data/universe.js";
import { getQuote, getHistory, subscribeToQuotes } from "../data/marketData.js";
import { getSeries, getCloses, getPriceAt, getTodayChange, get52wRange } from "../data/prices.js";
import { candleChart, lineChart } from "../components/charts.js";
import { formatRupees, formatPct, deltaClass, formatQty } from "../money.js";
import {
  getState, subscribe, applyTrade, recordCoachMessage, genId, addToWatchlist, removeFromWatchlist,
} from "../state.js";
import { coach } from "../coach/orchestrator.js";
import { detectPanicSell } from "../coach/biasDetectors.js";
import { buildAnalogContext } from "../coach/historicalAnalog.js";
import { showInterventionModal } from "../components/interventionModal.js";
import { mountQuantitySelector } from "../components/quantitySelector.js";
import { toast } from "../components/toast.js";

const TF_MAP = { "1W": { range: "5d", interval: "1d", days: 5 }, "1M": { range: "1mo", interval: "1d", days: 22 }, "3M": { range: "3mo", interval: "1d", days: 66 }, "6M": { range: "6mo", interval: "1d", days: 130 }, "1Y": { range: "1y", interval: "1d", days: 260 } };

let ui = { side: "BUY", qty: 1, timeframe: "1M" };
let liveQuote = null;
let liveHistory = null;
let qtySelectorHandle = null;
let _cancelToken = { cancelled: false };    // shared per-mount token

export function renderStockDetail(main, params) {
  const symbol = params.symbol;
  const inst = getInstrument(symbol);
  if (!inst) {
    main.innerHTML = `<div class="empty-state"><span class="emoji">🔍</span><h3>Instrument not found</h3><p>Symbol "${symbol}" isn't in the universe.</p><a href="#/stocks" class="btn btn-primary">Back</a></div>`;
    return;
  }

  // Cancel any previous mount's pending work
  _cancelToken.cancelled = true;
  _cancelToken = { cancelled: false };
  const myToken = _cancelToken;

  ui = { side: "BUY", qty: inst.kind === "MF" ? 0.5 : 1, timeframe: "1M" };
  liveQuote = null;
  liveHistory = null;
  qtySelectorHandle?.destroy?.();
  qtySelectorHandle = null;

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

  const curPrice = liveQuote?.pricePaise ?? getPriceAt(symbol, 0);
  const change = liveQuote?.changePct ?? getTodayChange(symbol);
  const dayChangeVal = Math.round(curPrice * change);

  const tfSpec = TF_MAP[ui.timeframe] || TF_MAP["1M"];
  const history = liveHistory?.ohlc?.length ? liveHistory.ohlc : getSeries(symbol).slice(-tfSpec.days);
  const closes = history.map(k => k.c);

  const { hi, lo } = get52wRange(symbol);
  const isWatched = state.watchlist.includes(symbol);

  const dataSource = liveQuote?.source === "yahoo" || liveQuote?.source === "finnhub"
    ? { label: "Live", live: true }
    : { label: "Cached", live: false };

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
                <span class="data-badge" style="margin-left: 8px;"><span class="dot ${dataSource.live ? "" : "offline"}"></span> ${dataSource.label}</span>
              </div>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm watch-btn">${isWatched ? "★ Watching" : "☆ Watchlist"}</button>
        </div>

        <div class="price-block" style="margin-top: var(--sp-4);">
          <div class="price tabular">${formatRupees(curPrice)}</div>
          <div class="change ${deltaClass(change)} tabular">
            ${formatRupees(dayChangeVal, { sign: true })} (${formatPct(change, { sign: true })}) today
          </div>
        </div>

        <div class="tf-buttons">
          ${["1W","1M","3M","6M","1Y"].map(tf => `<button class="tf-btn ${ui.timeframe === tf ? "active" : ""}" data-tf="${tf}">${tf}</button>`).join("")}
        </div>

        <div class="card" style="padding: var(--sp-3);">
          ${inst.kind === "MF"
            ? `<div style="height: 300px;">${lineChart(closes, { height: 300, color: "var(--brand)" })}</div>`
            : `<div style="height: 340px;">${candleChart(history, { height: 340 })}</div>`}
        </div>

        <div class="card" style="margin-top: var(--sp-4);">
          <h3 style="margin-bottom: var(--sp-4);">Fundamentals</h3>
          <div class="fundamentals">
            ${fundRow("Market Cap", inst.marketCap || "—")}
            ${fundRow("P/E Ratio", inst.pe ? inst.pe.toString() : "—")}
            ${fundRow("P/B Ratio", inst.pb ? inst.pb.toString() : "—")}
            ${fundRow("Div Yield", inst.divYield != null ? `${inst.divYield}%` : "—")}
            ${fundRow("Beta", inst.beta ? inst.beta.toString() : "—")}
            ${fundRow("52W High", formatRupees(hi))}
            ${fundRow("52W Low", formatRupees(lo))}
            ${fundRow("Risk tier", `<span class="risk-pill ${inst.risk}">${inst.risk.toUpperCase()}</span>`, true)}
            ${inst.kind === "MF" ? fundRow("Expense Ratio", `${inst.expenseRatio}%`) : ""}
            ${inst.kind === "MF" ? fundRow("AUM", inst.aum) : ""}
          </div>
        </div>
      </div>

      <aside>
        <div class="card trade-box">
          <div class="trade-tabs">
            <button class="trade-tab buy ${ui.side === "BUY" ? "active" : ""}" data-side="BUY">Buy</button>
            <button class="trade-tab sell ${ui.side === "SELL" ? "active" : ""}" data-side="SELL">Sell</button>
          </div>

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
            Review ${ui.side === "BUY" ? "Buy" : "Sell"} order
          </button>

          <div class="dim text-xs center" style="margin-top: var(--sp-3);">
            Virtual money · Reviewed on a confirmation step · Coach reflection follows every trade
          </div>
        </div>
      </aside>
    </div>
  `;

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

function attachListeners(main, inst, symbol, curPrice, holding) {
  main.querySelectorAll(".tf-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.timeframe = btn.dataset.tf;
      reloadHistory(inst, symbol);
    });
  });

  main.querySelectorAll("[data-side]").forEach(btn => {
    btn.addEventListener("click", () => {
      ui.side = btn.dataset.side;
      // Reset qty to sensible default on tab change
      ui.qty = inst.kind === "MF" ? 0.5 : 1;
      render(inst, symbol);
    });
  });

  main.querySelector(".watch-btn")?.addEventListener("click", () => {
    if (getState().watchlist.includes(symbol)) removeFromWatchlist(symbol);
    else addToWatchlist(symbol);
  });

  main.querySelector("#place-trade-btn")?.addEventListener("click", () => {
    reviewTrade(inst, symbol, curPrice, holding);
  });
}

function reviewTrade(inst, symbol, curPrice, holding) {
  const qty = qtySelectorHandle?.get?.() ?? ui.qty;
  if (!qty || qty <= 0) { toast({ kind: "error", message: "Enter a valid quantity." }); return; }
  if (ui.side === "SELL" && (!holding || holding.qty < qty - 1e-9)) {
    toast({ kind: "error", message: `You only hold ${holding?.qty || 0}.` });
    return;
  }
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
}

async function executeTrade(inst, side, qty, pricePaise, biasResult) {
  try {
    const idempotencyKey = `${Date.now()}_${inst.symbol}_${side}_${qty}_${Math.random()}`;
    const txn = applyTrade({
      symbol: inst.symbol, side, qty, pricePaise, idempotencyKey,
      biasFlags: biasResult ? [biasResult] : [],
    });
    toast({
      kind: "success",
      message: `${side === "BUY" ? "Bought" : "Sold"} ${formatQty(qty, inst.kind)} ${inst.symbol} @ ${formatRupees(pricePaise)}`,
    });
    const state = getState();
    const isFirstTrade = state.transactions.length === 1;
    const msg = await coach({ type: side, symbol: inst.symbol, qty, pricePaise, txnId: txn.id, isFirstTrade });
    recordCoachMessage(msg);
  } catch (e) {
    toast({ kind: "error", message: e.message || "Trade failed" });
    console.error(e);
  }
}

function fundRow(l, v, html = false) {
  return `<div class="item"><div class="l">${l}</div><div class="v">${html ? v : escapeHtml(v)}</div></div>`;
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
