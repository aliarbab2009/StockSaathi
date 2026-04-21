// =============================================================================
// STOCKS — Browse markets. Real-time prices via Yahoo Finance when possible.
// =============================================================================

import { STOCKS, MUTUAL_FUNDS, SECTORS, INSTRUMENTS } from "../data/universe.js";
import { getTodayChange, getCloses, marketStatus } from "../data/prices.js";
import { getQuoteBatch, getDataSource, subscribeToQuotes, getCachedQuotes, getIntradaySparkline } from "../data/marketData.js";
import { sparkline } from "../components/charts.js";
import { formatRupees, formatPct, deltaClass } from "../money.js";
import { getState, addToWatchlist, removeFromWatchlist, subscribe } from "../state.js";
import { toast } from "../components/toast.js";

let filter = { q: "", sector: "all", kind: "all", sort: "marketCap" };
let quoteCache = {};
let marketMood = null;       // { narrative, temperature } | null
let _moodFetched = false;
let aiSearch = null;          // { matches: ["TCS", ...], rationale: "..." } | null — when present, overrides the normal filter pipeline
let aiSearchLoading = false;
let aiSearchQuery = "";

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

  // Cover EVERY equity in the universe — no more 50-stock cap. getQuoteBatch
  // auto-chunks to stay under /api/live-quote's MAX_SYMBOLS=80, and the
  // Supabase quote_cache (10s TTL, shared across users) means Yahoo only
  // sees one hit per symbol per 10s regardless of how many users are
  // polling. MFs have no real-time feed and go through synthMFQuote.
  const allEquitySyms = STOCKS.map(s => s.symbol);

  (async () => {
    try {
      const q = await getQuoteBatch(allEquitySyms);
      if (cancelled) return;
      quoteCache = { ...quoteCache, ...q };
      render();
    } catch {}
  })();

  pollUnsub = subscribeToQuotes(allEquitySyms, (quotes) => {
    if (cancelled) return;
    quoteCache = { ...quoteCache, ...quotes };
    render();
    // Fire the daily market-mood card once quotes have landed for the
    // first time. Cached across the whole site per day, so most visits
    // are instant + free.
    if (!marketMood && !_moodFetched && Object.keys(quoteCache).length > 50) {
      _moodFetched = true;
      fetchMarketMood().then((m) => {
        if (cancelled) return;
        marketMood = m;
        render();
      }).catch(() => {});
    }
  }, 10_000);

  function render() {
    const state = getState();
    const list = applyFilters(INSTRUMENTS, filter, state, quoteCache);
    const src = getDataSource();
    // Preserve focus + caret on the search input across the re-render — every
    // keystroke triggers this render and the 10s live-quote poll does too, so
    // without this the user can't type more than one character at a time.
    const active = document.activeElement;
    const restore = active && active.id === "stocks-search" ? {
      start: active.selectionStart,
      end: active.selectionEnd,
    } : null;
    main.innerHTML = `
      <div class="flex items-start justify-between wrap gap-3" style="margin-bottom: var(--sp-4);">
        <div>
          <h1>Markets</h1>
          <p class="muted">${INSTRUMENTS.length} instruments · ${STOCKS.length} equities · ${MUTUAL_FUNDS.length} mutual funds</p>
        </div>
        <span class="data-badge"><span class="dot"></span> ${escapeHtml(src.name)}</span>
      </div>

      ${marketMood ? `
        <div class="market-mood-card mood-${escapeAttr(marketMood.temperature)}">
          <div class="mood-head">
            <span class="pf-digest-label">Today's mood</span>
            <span class="mood-pill mood-${escapeAttr(marketMood.temperature)}">${escapeHtml(marketMood.temperature)}</span>
          </div>
          <div class="mood-body">${escapeHtml(marketMood.narrative)}</div>
        </div>
      ` : ""}

      ${aiSearch ? `
        <div class="ai-search-result-card">
          <div class="flex items-center gap-2" style="margin-bottom: 6px;">
            <span class="pf-digest-label">Saathi filter</span>
            <span class="dim text-xs">"${escapeHtml(aiSearchQuery)}" · ${aiSearch.matches.length} matches</span>
            <button class="btn btn-ghost btn-sm" id="ai-search-clear" style="margin-left:auto;">✕ Clear</button>
          </div>
          ${aiSearch.rationale ? `<div class="muted text-sm" style="margin-bottom: 8px;">${escapeHtml(aiSearch.rationale)}</div>` : ""}
        </div>
      ` : ""}

      <div class="stocks-toolbar">
        <div class="input-prefix">
          <span class="px">🔍</span>
          <input type="search" id="stocks-search" placeholder="Search, or try &quot;cheap IT stocks with low debt&quot;..." value="${escapeAttr(filter.q)}" />
        </div>
        <button class="btn btn-ghost btn-sm" id="ask-saathi-btn" title="Filter the universe with natural language" ${aiSearchLoading ? "disabled" : ""}>${aiSearchLoading ? "…" : "✨ Ask Saathi"}</button>
        <div id="stocks-sort" style="min-width: 200px;"></div>
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

    const searchEl = main.querySelector("#stocks-search");
    if (restore) {
      searchEl.focus();
      try { searchEl.setSelectionRange(restore.start, restore.end); } catch {}
    }
    searchEl.addEventListener("input", e => { filter.q = e.target.value; render(); });
    import("../components/themedSelect.js").then(({ mountThemedSelect }) => {
      mountThemedSelect(main.querySelector("#stocks-sort"), {
        value: filter.sort,
        options: [
          { value: "marketCap", label: "Top by size" },
          { value: "gainers",   label: "Top gainers today" },
          { value: "losers",    label: "Top losers today" },
          { value: "name",      label: "Name A–Z" },
        ],
        onChange: v => { filter.sort = v; render(); },
      });
    });
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

    main.querySelector("#ask-saathi-btn")?.addEventListener("click", () => {
      const q = filter.q.trim();
      if (q.length < 3) {
        toast({ kind: "info", message: "Type a few words — e.g. 'IT stocks with low debt' — then hit Ask Saathi." });
        return;
      }
      runAiSearch(q, render);
    });
    main.querySelector("#ai-search-clear")?.addEventListener("click", () => {
      aiSearch = null;
      aiSearchQuery = "";
      render();
    });
    // Also trigger AI search on Enter inside the search input when the
    // query has multiple words (looks like natural language, not a ticker).
    searchEl.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const q = filter.q.trim();
        if (q.split(/\s+/).length >= 2 && q.length >= 6) {
          e.preventDefault();
          runAiSearch(q, render);
        }
      }
    });
  }
}

async function runAiSearch(query, render) {
  if (aiSearchLoading) return;
  aiSearchLoading = true;
  aiSearchQuery = query;
  render();
  try {
    // Build candidate rows from INSTRUMENTS + live quoteCache for dayPct.
    const candidates = INSTRUMENTS.slice(0, 200).map(i => {
      const q = quoteCache[i.symbol];
      return {
        symbol: i.symbol,
        name: i.name,
        sector: i.sector || "",
        marketCap: i.marketCap || "",
        pe: i.pe ?? null,
        pb: i.pb ?? null,
        divYield: i.divYield ?? null,
        beta: i.beta ?? null,
        risk: i.risk || "",
        dayPct: q?.changePct != null ? q.changePct * 100 : null,
      };
    });
    const res = await fetch("/api/ai?op=market-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, candidates }),
    });
    if (!res.ok) throw new Error("http_" + res.status);
    const d = await res.json();
    aiSearch = d?.matches?.length ? { matches: d.matches, rationale: d.rationale || "" } : { matches: [], rationale: d?.rationale || "No matches in the current universe." };
  } catch (e) {
    aiSearch = { matches: [], rationale: "Saathi couldn't search just now. Try again in a moment." };
  } finally {
    aiSearchLoading = false;
    render();
  }
}

async function fetchMarketMood() {
  const bySector = {};
  for (const inst of INSTRUMENTS) {
    const q = quoteCache[inst.symbol];
    if (!q || typeof q.changePct !== "number" || !inst.sector) continue;
    if (!bySector[inst.sector]) bySector[inst.sector] = { pcts: [], up: { sym: "", pct: -Infinity }, down: { sym: "", pct: Infinity } };
    const pct = q.changePct * 100;
    bySector[inst.sector].pcts.push(pct);
    if (pct > bySector[inst.sector].up.pct) bySector[inst.sector].up = { sym: inst.symbol, pct };
    if (pct < bySector[inst.sector].down.pct) bySector[inst.sector].down = { sym: inst.symbol, pct };
  }
  const sectors = Object.entries(bySector)
    .map(([name, v]) => ({
      name,
      avgPct: v.pcts.reduce((a, b) => a + b, 0) / v.pcts.length,
      count: v.pcts.length,
      topUp: v.up.sym ? `${v.up.sym} ${v.up.pct>=0?"+":""}${v.up.pct.toFixed(1)}%` : "",
      topDown: v.down.sym ? `${v.down.sym} ${v.down.pct>=0?"+":""}${v.down.pct.toFixed(1)}%` : "",
    }))
    .sort((a, b) => Math.abs(b.avgPct) - Math.abs(a.avgPct))
    .slice(0, 10);
  if (!sectors.length) return null;
  const r = await fetch("/api/ai?op=market-mood", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sectors, asOf: Date.now() }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d?.narrative) return null;
  return d;
}

// Parse the "1.25L Cr", "87,500 Cr", "3.2L Cr" style strings in universe.js
// into a plain number of crores so we can sort numerically. Falls back to
// 0 for anything we can't parse — those sink to the bottom, which is fine.
function parseMarketCapCr(s) {
  if (!s) return 0;
  const str = String(s).toLowerCase().replace(/,/g, "").trim();
  const n = parseFloat(str);
  if (!Number.isFinite(n)) return 0;
  if (str.includes("l cr") || str.includes("lc")) return n * 1e5;   // lakh crore
  if (str.includes("k cr")) return n * 1e3;
  return n;
}

function changeFor(sym, quoteCache) {
  const q = quoteCache?.[sym];
  if (q && Number.isFinite(q.changePct)) return q.changePct;
  return getTodayChange(sym);
}

function applyFilters(all, f, state, quoteCache) {
  // If an AI-search result is active, it overrides the keyword filter
  // entirely — show exactly the AI's ordered matches. Other filters
  // (sector, kind) still stack on top.
  if (aiSearch && aiSearch.matches && aiSearch.matches.length) {
    const orderMap = new Map(aiSearch.matches.map((s, i) => [s, i]));
    let list = all.filter(i => orderMap.has(i.symbol));
    if (f.kind === "EQUITY") list = list.filter(i => i.kind === "EQUITY");
    else if (f.kind === "MF") list = list.filter(i => i.kind === "MF");
    else if (f.kind === "watchlist") {
      const wl = new Set(state.watchlist);
      list = list.filter(i => wl.has(i.symbol));
    }
    if (f.sector !== "all") list = list.filter(i => i.sector === f.sector);
    list.sort((a, b) => orderMap.get(a.symbol) - orderMap.get(b.symbol));
    return list;
  }
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
  if (f.sort === "gainers") list.sort((a, b) => changeFor(b.symbol, quoteCache) - changeFor(a.symbol, quoteCache));
  else if (f.sort === "losers") list.sort((a, b) => changeFor(a.symbol, quoteCache) - changeFor(b.symbol, quoteCache));
  else if (f.sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  else if (f.sort === "marketCap") list.sort((a, b) => parseMarketCapCr(b.marketCap) - parseMarketCapCr(a.marketCap));
  return list;
}

function renderStockCard(inst, state) {
  // Prefer the rolling intraday buffer built from live polls — falls back
  // to the seeded 40-day walk on cold load before any poll has landed.
  const closes = getIntradaySparkline(inst.symbol, getCloses(inst.symbol, 40));
  const quote = quoteCache[inst.symbol];
  // LIVE first, always. inst.price is a seeded reference only — used as an
  // initial skeleton placeholder before live data arrives. When the universe
  // scales to all ~2000 NSE stocks, hand-maintaining static prices is
  // impossible, so the UI must tolerate no-static-price gracefully.
  const hasLive = quote?.pricePaise != null;
  const price = hasLive ? quote.pricePaise : (inst.price ?? null);
  const change = quote?.changePct ?? (inst.price != null ? getTodayChange(inst.symbol) : 0);
  const isWatched = state.watchlist.includes(inst.symbol);
  // Badge logic:
  //   market-closed  → CLOSED pill with last-close time (even if we have a quote
  //                    cached from the final trading tick, it's by definition
  //                    not live anymore outside session hours)
  //   MF             → NAV (end-of-day; no intraday NSE feed for mutual funds)
  //   live & fresh   → LIVE
  //   live & stale   → DELAYED Xm old
  //   seeded only    → SYNCING
  const ms = marketStatus();
  let badge = "";
  if (inst.kind === "MF") {
    badge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Mutual Fund NAV — refreshed once per day after market close">NAV</span>`;
  } else if (ms.state !== "open") {
    const lbl = ms.state === "pre-open" ? "PRE-OPEN" : "CLOSED";
    // Rich hover popover rather than a native title= tooltip.
    const pop = `
      <div class="market-status-pop" role="tooltip">
        <div class="ms-pop-head">
          <span class="ms-pop-label">NSE · ${ms.state === "pre-open" ? "Pre-open" : "Closed"}</span>
        </div>
        <div class="ms-pop-row"><span class="ms-pop-key">Now</span><span>${escapeHtml(ms.istDate)} · ${escapeHtml(ms.istTime)}</span></div>
        ${ms.state === "pre-open"
          ? `<div class="ms-pop-row"><span class="ms-pop-key">Opens</span><span>9:15 AM IST today</span></div>`
          : `<div class="ms-pop-row"><span class="ms-pop-key">Last close</span><span>${escapeHtml(ms.lastCloseLabel || "—")}</span></div>`
        }
        ${ms.nextOpenLabel ? `<div class="ms-pop-row"><span class="ms-pop-key">Next open</span><span>${escapeHtml(ms.nextOpenLabel)}</span></div>` : ""}
        ${ms.isHoliday ? `<div class="ms-pop-row"><span class="ms-pop-key">Holiday</span><span>Yes</span></div>` : ""}
        <div class="ms-pop-row"><span class="ms-pop-key">Hours</span><span>Mon–Fri · 9:15–3:30 IST</span></div>
        <div class="ms-pop-foot">Clock is server-trusted.</div>
      </div>
    `;
    badge = `<span class="pill stock-card-ms-pill market-status" tabindex="0" data-ms-state="${ms.state}" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim); position: relative;">${lbl}${pop}</span>`;
  } else if (quote?.source && quote.source !== "mf-static" && quote.source !== "synthetic") {
    if (quote.stale) {
      const ageLabel = quote.staleAgeMinutes >= 60
        ? `${(quote.staleAgeMinutes / 60).toFixed(1)}h old`
        : `${quote.staleAgeMinutes}m old`;
      const asOf = quote.ts ? new Date(quote.ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";
      badge = `<span class="pill pill-yellow" style="font-size: 9px; padding: 1px 6px;" title="Data as of ${asOf} IST — upstream feed is behind">DELAYED ${ageLabel}</span>`;
    } else {
      badge = `<span class="pill pill-green" style="font-size: 9px; padding: 1px 6px;" title="NSE · Live">LIVE</span>`;
    }
  } else if (inst.price != null) {
    badge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Live feed syncing — price shown is a reference, not current">SYNCING</span>`;
  }
  const liveBadge = badge;
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
          <div class="stock-price tabular">${price != null ? formatRupees(price) : `<span class="dim">₹—</span>`}</div>
          <div class="stock-change ${deltaClass(change)}">${hasLive ? `${formatPct(change, { sign: true })} today` : `<span class="dim">—</span>`} ${liveBadge}</div>
        </div>
        <span class="risk-pill ${inst.risk || "med"}">${(inst.risk || "MED").toUpperCase()}</span>
      </div>
      <div class="stock-sparkline">${sparkline(closes)}</div>
    </div>
  `;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
