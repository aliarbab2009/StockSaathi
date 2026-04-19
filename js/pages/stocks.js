// =============================================================================
// STOCKS — Browse markets. Real-time prices via Yahoo Finance when possible.
// =============================================================================

import { STOCKS, MUTUAL_FUNDS, SECTORS, INSTRUMENTS } from "../data/universe.js";
import { getTodayChange, getCloses } from "../data/prices.js";
import { getQuoteBatch, getDataSource, subscribeToQuotes, getCachedQuotes } from "../data/marketData.js";
import { sparkline } from "../components/charts.js";
import { formatRupees, formatPct, deltaClass } from "../money.js";
import { getState, addToWatchlist, removeFromWatchlist, subscribe } from "../state.js";

let filter = { q: "", sector: "all", kind: "all", sort: "marketCap" };
let quoteCache = {};

export function renderStocks(main) {
  let cancelled = false;
  let pollUnsub = null;

  // Prefill from in-memory + localStorage cache SYNCHRONOUSLY so the very first
  // paint already shows last-known real prices (not universe placeholders).
  const allSyms = INSTRUMENTS.map(i => i.symbol);
  quoteCache = { ...quoteCache, ...getCachedQuotes(allSyms) };

  render();
  const unsub = subscribe(() => { if (!cancelled) render(); });
  const onLeave = () => { cancelled = true; unsub?.(); pollUnsub?.(); };
  window.addEventListener("hashchange", onLeave, { once: true });

  // Two-wave fetch: top-20 lands fast (≤4s), then the rest in background.
  const wave1 = STOCKS.slice(0, 20).map(s => s.symbol);
  const wave2 = STOCKS.slice(20, 50).map(s => s.symbol);

  (async () => {
    try {
      const q1 = await getQuoteBatch(wave1);
      if (cancelled) return;
      quoteCache = { ...quoteCache, ...q1 };
      render();
    } catch {}
    try {
      const q2 = await getQuoteBatch(wave2);
      if (cancelled) return;
      quoteCache = { ...quoteCache, ...q2 };
      render();
    } catch {}
  })();

  // Then 10s polling over all top-50 to keep fresh
  pollUnsub = subscribeToQuotes([...wave1, ...wave2], (quotes) => {
    if (cancelled) return;
    quoteCache = { ...quoteCache, ...quotes };
    render();
  }, 10_000);

  function render() {
    const state = getState();
    const list = applyFilters(INSTRUMENTS, filter, state);
    const src = getDataSource();
    main.innerHTML = `
      <div class="flex items-start justify-between wrap gap-3" style="margin-bottom: var(--sp-4);">
        <div>
          <h1>Markets</h1>
          <p class="muted">${INSTRUMENTS.length} instruments · ${STOCKS.length} equities · ${MUTUAL_FUNDS.length} mutual funds</p>
        </div>
        <span class="data-badge"><span class="dot"></span> ${escapeHtml(src.name)}</span>
      </div>

      <div class="stocks-toolbar">
        <div class="input-prefix">
          <span class="px">🔍</span>
          <input type="search" id="stocks-search" placeholder="Search stocks, mutual funds, sectors..." value="${escapeAttr(filter.q)}" />
        </div>
        <select class="select" id="stocks-sort" style="max-width: 200px;">
          <option value="marketCap" ${filter.sort === "marketCap" ? "selected" : ""}>Top by size</option>
          <option value="gainers" ${filter.sort === "gainers" ? "selected" : ""}>Top gainers today</option>
          <option value="losers" ${filter.sort === "losers" ? "selected" : ""}>Top losers today</option>
          <option value="name" ${filter.sort === "name" ? "selected" : ""}>Name A-Z</option>
        </select>
      </div>

      <div class="filter-pills" style="margin-bottom: var(--sp-3);">
        <button class="filter-pill ${filter.kind === "all" ? "active" : ""}" data-kind="all">All</button>
        <button class="filter-pill ${filter.kind === "EQUITY" ? "active" : ""}" data-kind="EQUITY">Stocks</button>
        <button class="filter-pill ${filter.kind === "MF" ? "active" : ""}" data-kind="MF">Mutual Funds</button>
        <button class="filter-pill ${filter.kind === "watchlist" ? "active" : ""}" data-kind="watchlist">★ Watchlist (${state.watchlist.length})</button>
      </div>
      <div class="filter-pills" style="margin-bottom: var(--sp-5);">
        <button class="filter-pill ${filter.sector === "all" ? "active" : ""}" data-sector="all">All sectors</button>
        ${SECTORS.map(s => `<button class="filter-pill ${filter.sector === s ? "active" : ""}" data-sector="${escapeAttr(s)}">${escapeHtml(s)}</button>`).join("")}
      </div>

      ${list.length === 0
        ? `<div class="empty-state"><span class="emoji">🔍</span><h3>No matches</h3><p>Try clearing a filter or searching differently.</p></div>`
        : `<div class="stocks-grid">${list.map(inst => renderStockCard(inst, state)).join("")}</div>`}
    `;

    main.querySelector("#stocks-search").addEventListener("input", e => { filter.q = e.target.value; render(); });
    main.querySelector("#stocks-sort").addEventListener("change", e => { filter.sort = e.target.value; render(); });
    main.querySelectorAll("[data-sector]").forEach(btn => btn.addEventListener("click", () => { filter.sector = btn.dataset.sector; render(); }));
    main.querySelectorAll("[data-kind]").forEach(btn => btn.addEventListener("click", () => { filter.kind = btn.dataset.kind; render(); }));
    main.querySelectorAll(".stock-card").forEach(card => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".watchlist-toggle")) return;
        location.hash = "#/stocks/" + card.dataset.sym;
      });
    });
    main.querySelectorAll(".watchlist-toggle").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const sym = btn.dataset.sym;
        if (state.watchlist.includes(sym)) removeFromWatchlist(sym);
        else addToWatchlist(sym);
      });
    });
  }
}

function applyFilters(all, f, state) {
  let list = all.slice();
  if (f.kind === "EQUITY") list = list.filter(i => i.kind === "EQUITY");
  else if (f.kind === "MF") list = list.filter(i => i.kind === "MF");
  else if (f.kind === "watchlist") {
    const wl = new Set(state.watchlist);
    list = list.filter(i => wl.has(i.symbol));
  }
  if (f.sector !== "all") list = list.filter(i => i.sector === f.sector);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter(i =>
      i.name.toLowerCase().includes(q) ||
      i.symbol.toLowerCase().includes(q) ||
      (i.sector || "").toLowerCase().includes(q)
    );
  }
  if (f.sort === "gainers") list.sort((a, b) => getTodayChange(b.symbol) - getTodayChange(a.symbol));
  else if (f.sort === "losers") list.sort((a, b) => getTodayChange(a.symbol) - getTodayChange(b.symbol));
  else if (f.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function renderStockCard(inst, state) {
  const closes = getCloses(inst.symbol, 40);
  const quote = quoteCache[inst.symbol];
  const price = quote?.pricePaise ?? inst.price;
  const change = quote?.changePct ?? getTodayChange(inst.symbol);
  const isWatched = state.watchlist.includes(inst.symbol);
  const liveBadge = quote?.source && !quote.stale ? `<span class="pill pill-green" style="font-size: 9px; padding: 1px 6px;">LIVE</span>` : "";
  return `
    <div class="stock-card" data-sym="${inst.symbol}" role="button" tabindex="0" aria-label="${escapeAttr(inst.name)}">
      <div class="stock-head">
        <div class="stock-avatar">${escapeHtml(inst.logo || inst.symbol.slice(0, 3))}</div>
        <div class="stock-title">
          <div class="name">${escapeHtml(inst.name)}</div>
          <div class="sym">${inst.symbol} · ${escapeHtml(inst.sector || "")}</div>
        </div>
        <button class="watchlist-toggle" data-sym="${inst.symbol}" title="${isWatched ? "Remove from watchlist" : "Add to watchlist"}" aria-label="${isWatched ? "Remove" : "Add"}" style="background: transparent; padding: 4px; font-size: 16px;">${isWatched ? "★" : "☆"}</button>
      </div>
      <div class="flex items-center justify-between">
        <div>
          <div class="stock-price tabular">${formatRupees(price)}</div>
          <div class="stock-change ${deltaClass(change)}">${formatPct(change, { sign: true })} today ${liveBadge}</div>
        </div>
        <span class="risk-pill ${inst.risk}">${inst.risk.toUpperCase()}</span>
      </div>
      <div class="stock-sparkline">${sparkline(closes)}</div>
    </div>
  `;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
