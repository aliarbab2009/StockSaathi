// =============================================================================
// STOCKS — Browse markets. Real-time prices via Yahoo Finance when possible.
// =============================================================================

import { STOCKS, MUTUAL_FUNDS, SECTORS, INSTRUMENTS, getAllInstruments, getAllSectors, ensureUniverseLoaded } from "../data/universe.js";
import { getTodayChange, getCloses, marketStatus } from "../data/prices.js";
import { getQuoteBatch, getDataSource, subscribeToQuotes, getCachedQuotes, getFreshCachedQuotes, getIntradaySparkline } from "../data/marketData.js";
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
let aiSearchAbort = null;     // AbortController for the in-flight /api/ai call
let visibleCount = 100;       // pagination window — grows with "Show more"
const PAGE_SIZE = 100;
let _debounceTimer = null;

// Keywords that let the Ask-Saathi prefilter narrow a 2k-candidate pool down
// to ~150 without sending everything to the LLM. Maps lowercase tokens to
// filter predicates applied against the full-universe row shape.
const CAP_KEYWORDS = {
  largecap: ["mega", "large"], "large cap": ["mega", "large"], "large-cap": ["mega", "large"],
  midcap: ["mid"], "mid cap": ["mid"], "mid-cap": ["mid"],
  smallcap: ["small", "micro"], "small cap": ["small", "micro"], "small-cap": ["small", "micro"],
  bluechip: ["mega"], "blue chip": ["mega"], "blue-chip": ["mega"],
  nifty50: ["mega"], "nifty 50": ["mega"],
};
const RISK_KEYWORDS = {
  safe: "low", stable: "low", defensive: "low", steady: "low",
  risky: "high", volatile: "high", speculative: "high", aggressive: "high",
  moderate: "med",
};

export function renderStocks(main) {
  let cancelled = false;
  let pollUnsub = null;

  // Reset transient state on every (re-)entry so a stale in-flight AI
  // fetch or broken loading flag from the previous session doesn't leak
  // into this one. Filter + quoteCache + marketMood persist across
  // navigation on purpose — the user gets back exactly where they left off.
  aiSearchLoading = false;
  if (aiSearchAbort) { try { aiSearchAbort.abort(); } catch {} aiSearchAbort = null; }
  visibleCount = PAGE_SIZE;

  // Nudge the full universe to load if it hasn't already — no-op if cached
  // or already in flight. Kicks the JSON fetch early so the "All NSE" pill
  // is click-ready by the time the user scans the toolbar.
  ensureUniverseLoaded();

  // Source list depends on the kind pill:
  //   - "ALL_NSE" → full merged universe (~2700 rows, Tier 1 + Tier 2)
  //   - everything else → curated-only (~127 rows, fast render)
  function source() {
    return filter.kind === "ALL_NSE" ? getAllInstruments() : INSTRUMENTS;
  }

  // Prefill from in-memory cache SYNCHRONOUSLY so the very first paint
  // shows last-known REAL-FRESH prices (not universe placeholders, and
  // not stale localStorage-persisted quotes from hours/days ago).
  // getFreshCachedQuotes: during market hours, only returns cache entries
  // younger than 30s whose upstream timestamp wasn't stale either. Outside
  // market hours, returns whatever we have (yesterday's close is truth).
  // Anything that's missing or stale falls through to skeleton cards in
  // renderStockCard until the first getQuoteBatch() returns below.
  const allSyms = INSTRUMENTS.map(i => i.symbol);
  quoteCache = { ...quoteCache, ...getFreshCachedQuotes(allSyms) };

  render();
  const unsub = subscribe(() => { if (!cancelled) render(); });
  // Full universe lands asynchronously — re-render when the loader fires so
  // the instrument count pill and "All NSE" source both pick up Tier 2.
  const onUniverseLoaded = () => { if (!cancelled) render(); };
  window.addEventListener("ss:universe-loaded", onUniverseLoaded);
  const onLeave = () => {
    cancelled = true;
    unsub?.();
    pollUnsub?.();
    window.removeEventListener("ss:universe-loaded", onUniverseLoaded);
    if (aiSearchAbort) { try { aiSearchAbort.abort(); } catch {} aiSearchAbort = null; }
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  };
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
      renderList();   // just the grid — toolbar already up
    } catch {}
  })();

  pollUnsub = subscribeToQuotes(allEquitySyms, (quotes) => {
    if (cancelled) return;
    quoteCache = { ...quoteCache, ...quotes };
    // Quote-tick update: ONLY the stock-card grid is re-rendered. The
    // toolbar (search input + themed-select Top-by-size dropdown) and
    // filter pills stay in place — this kills the "blink" where the
    // sort dropdown flashed on every 10-second tick because the entire
    // main.innerHTML was being rebuilt.
    renderList();
    if (!marketMood && !_moodFetched && Object.keys(quoteCache).length > 50) {
      _moodFetched = true;
      fetchMarketMood().then((m) => {
        if (cancelled) return;
        marketMood = m;
        render();   // mood card is structural, needs full render once
      }).catch(() => {});
    }
  }, 10_000);

  function render() {
    const state = getState();
    const wlSet = new Set(state.watchlist);
    const fullList = applyFilters(source(), filter, state, quoteCache);
    const list = fullList.slice(0, visibleCount);
    const truncated = fullList.length > list.length;
    const src = getDataSource();
    const allInst = getAllInstruments();
    const allSectorsList = getAllSectors();
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
          <p class="muted">${allInst.length} instruments · ${STOCKS.length} featured · ${allInst.length - INSTRUMENTS.length > 0 ? `${allInst.length - INSTRUMENTS.length} more NSE listings` : `${MUTUAL_FUNDS.length} mutual funds`}</p>
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
        <button class="filter-pill ${filter.kind === "all" ? "active" : ""}" data-kind="all">Featured</button>
        <button class="filter-pill ${filter.kind === "ALL_NSE" ? "active" : ""}" data-kind="ALL_NSE">All NSE (${allInst.length})</button>
        <button class="filter-pill ${filter.kind === "EQUITY" ? "active" : ""}" data-kind="EQUITY">Stocks</button>
        <button class="filter-pill ${filter.kind === "MF" ? "active" : ""}" data-kind="MF">Mutual Funds</button>
        <button class="filter-pill ${filter.kind === "watchlist" ? "active" : ""}" data-kind="watchlist">★ Watchlist (${state.watchlist.length})</button>
      </div>
      <div class="filter-pills" style="margin-bottom: var(--sp-5); max-height: 88px; overflow-y: auto;">
        <button class="filter-pill ${filter.sector === "all" ? "active" : ""}" data-sector="all">All sectors</button>
        ${(filter.kind === "ALL_NSE" ? allSectorsList : SECTORS).map(s => `<button class="filter-pill ${filter.sector === s ? "active" : ""}" data-sector="${escapeAttr(s)}">${escapeHtml(s)}</button>`).join("")}
      </div>

      <div id="stocks-grid-host">${list.length === 0
        ? `<div class="empty-state"><span class="emoji">🔍</span><h3>No matches</h3><p>Try clearing a filter or searching differently.</p></div>`
        : `<div class="stocks-grid">${list.map(inst => renderStockCard(inst, state, wlSet)).join("")}</div>${truncated ? `<div class="flex justify-center" style="margin-top: var(--sp-4); gap: 8px;"><button class="btn btn-ghost" id="stocks-show-more">Show ${Math.min(PAGE_SIZE, fullList.length - list.length)} more (${fullList.length - list.length} remaining)</button><button class="btn btn-ghost" id="stocks-show-all">Show all ${fullList.length}</button></div>` : ""}`}</div>
    `;

    const searchEl = main.querySelector("#stocks-search");
    if (restore) {
      searchEl.focus();
      try { searchEl.setSelectionRange(restore.start, restore.end); } catch {}
    }
    searchEl.addEventListener("input", e => {
      filter.q = e.target.value;
      visibleCount = PAGE_SIZE;   // reset pagination on new query
      // Debounce: full re-renders every keystroke get expensive at 2700
      // cards even with virtualization. 120ms feels responsive.
      if (_debounceTimer) clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => { if (!cancelled) render(); }, 120);
    });
    import("../components/themedSelect.js").then(({ mountThemedSelect }) => {
      mountThemedSelect(main.querySelector("#stocks-sort"), {
        value: filter.sort,
        options: [
          { value: "marketCap", label: "Top by size" },
          { value: "gainers",   label: "Top gainers today" },
          { value: "losers",    label: "Top losers today" },
          { value: "name",      label: "Name A–Z" },
        ],
        onChange: v => { filter.sort = v; visibleCount = PAGE_SIZE; render(); },
      });
    });
    main.querySelectorAll("[data-sector]").forEach(btn => btn.addEventListener("click", () => { filter.sector = btn.dataset.sector; visibleCount = PAGE_SIZE; render(); }));
    main.querySelectorAll("[data-kind]").forEach(btn => btn.addEventListener("click", () => {
      filter.kind = btn.dataset.kind;
      filter.sector = "all";      // sector list changes between curated and All-NSE views
      visibleCount = PAGE_SIZE;
      render();
    }));
    main.querySelector("#stocks-show-more")?.addEventListener("click", () => { visibleCount += PAGE_SIZE; render(); });
    main.querySelector("#stocks-show-all")?.addEventListener("click", () => { visibleCount = 1e9; render(); });
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
        if (wlSet.has(sym)) removeFromWatchlist(sym);
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

  // Quote-tick path: rebuild ONLY the stocks grid. The toolbar (search
  // input, Top-by-size dropdown, filter pills) stays intact, so the
  // themed-select doesn't get torn down + re-mounted every 10 seconds
  // and the dropdown stops blinking.
  function renderList() {
    const state = getState();
    const wlSet = new Set(state.watchlist);
    const host = main.querySelector("#stocks-grid-host");
    if (!host) {
      // Shell not mounted yet — fall back to full render.
      render();
      return;
    }
    const fullList = applyFilters(source(), filter, state, quoteCache);
    const list = fullList.slice(0, visibleCount);
    const truncated = fullList.length > list.length;
    host.innerHTML = list.length === 0
      ? `<div class="empty-state"><span class="emoji">🔍</span><h3>No matches</h3><p>Try clearing a filter or searching differently.</p></div>`
      : `<div class="stocks-grid">${list.map(inst => renderStockCard(inst, state, wlSet)).join("")}</div>${truncated ? `<div class="flex justify-center" style="margin-top: var(--sp-4); gap: 8px;"><button class="btn btn-ghost" id="stocks-show-more">Show ${Math.min(PAGE_SIZE, fullList.length - list.length)} more (${fullList.length - list.length} remaining)</button><button class="btn btn-ghost" id="stocks-show-all">Show all ${fullList.length}</button></div>` : ""}`;
    // Re-wire the per-card listeners since the grid innerHTML was replaced.
    host.querySelectorAll(".stock-card").forEach(card => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".watchlist-toggle")) return;
        location.hash = "#/stocks/" + card.dataset.sym;
      });
    });
    host.querySelectorAll(".watchlist-toggle").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const sym = btn.dataset.sym;
        if (wlSet.has(sym)) removeFromWatchlist(sym);
        else addToWatchlist(sym);
      });
    });
    host.querySelector("#stocks-show-more")?.addEventListener("click", () => { visibleCount += PAGE_SIZE; renderList(); });
    host.querySelector("#stocks-show-all")?.addEventListener("click", () => { visibleCount = 1e9; renderList(); });
  }
}

async function runAiSearch(query, render) {
  if (aiSearchLoading) return;
  // Abort any prior in-flight AI call so stale responses can't overwrite the
  // current one.
  if (aiSearchAbort) { try { aiSearchAbort.abort(); } catch {} }
  aiSearchAbort = new AbortController();
  const signal = aiSearchAbort.signal;

  aiSearchLoading = true;
  aiSearchQuery = query;
  render();
  try {
    const candidates = buildAiSearchCandidates(query);
    const res = await fetch("/api/ai?op=market-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, candidates }),
      signal,
    });
    if (!res.ok) throw new Error("http_" + res.status);
    const d = await res.json();
    if (signal.aborted) return;
    aiSearch = d?.matches?.length ? { matches: d.matches, rationale: d.rationale || "" } : { matches: [], rationale: d?.rationale || "No matches in the current universe." };
  } catch (e) {
    if (signal.aborted || e.name === "AbortError") return;
    aiSearch = { matches: [], rationale: "Saathi couldn't search just now. Try again in a moment." };
  } finally {
    if (aiSearchAbort && aiSearchAbort.signal === signal) aiSearchAbort = null;
    aiSearchLoading = false;
    render();
  }
}

// Client-side prefilter: parse the query for sector / cap-bucket / risk /
// numeric hints, intersect with the full universe, rank by index prominence,
// truncate to the top 150 before handing to the LLM. At 2700 instruments a
// naive slice(0, 200) would silently miss 92% of the universe and burn ~62k
// input tokens per query; this keeps token cost flat vs curated-only while
// making every NSE symbol reachable.
function buildAiSearchCandidates(query) {
  const full = getAllInstruments();
  const byCap = new Map(full.map(i => [i.symbol, i.capBucket || "unknown"]));
  const q = query.toLowerCase();

  // 1) Parse hints
  const capHints = new Set();
  for (const [kw, buckets] of Object.entries(CAP_KEYWORDS)) {
    if (q.includes(kw)) buckets.forEach(b => capHints.add(b));
  }
  const riskHints = new Set();
  for (const [kw, r] of Object.entries(RISK_KEYWORDS)) {
    if (q.includes(kw)) riskHints.add(r);
  }
  const sectorHints = new Set();
  for (const s of getAllSectors()) {
    const sl = s.toLowerCase();
    if (sl && sl !== "other" && q.includes(sl)) sectorHints.add(s);
  }
  // Broader keyword → sector aliases that NSE doesn't name directly
  const SECTOR_ALIASES = {
    bank: "Banking", banks: "Banking", banking: "Banking",
    pharma: "Pharma", pharmaceutical: "Pharma", drug: "Pharma",
    it: "IT Services", tech: "IT Services", software: "IT Services",
    auto: "Auto", car: "Auto", motor: "Auto", vehicle: "Auto",
    fmcg: "FMCG", consumer: "Consumer",
    metal: "Metals", steel: "Metals",
    oil: "Energy", gas: "Energy", energy: "Energy",
    power: "Power", electric: "Power",
    realty: "Real Estate", "real estate": "Real Estate", property: "Real Estate",
    cement: "Cement",
    telecom: "Telecom", mobile: "Telecom",
    insurance: "Insurance",
    finance: "NBFC", nbfc: "NBFC", lending: "NBFC",
    chemical: "Chemicals",
    infrastructure: "Infrastructure", infra: "Infrastructure",
    airline: "Aviation", aviation: "Aviation",
    retail: "Retail", ecommerce: "Internet", internet: "Internet",
    healthcare: "Healthcare", hospital: "Healthcare",
  };
  for (const [kw, sec] of Object.entries(SECTOR_ALIASES)) {
    if (q.includes(kw)) sectorHints.add(sec);
  }

  // 2) Prefilter
  let pool = full;
  if (sectorHints.size) pool = pool.filter(i => sectorHints.has(i.sector));
  if (capHints.size) pool = pool.filter(i => capHints.has(byCap.get(i.symbol)));
  if (riskHints.size) pool = pool.filter(i => riskHints.has(i.risk || "med"));

  // 3) Rank by index prominence (Nifty50 first, then 100, 500, midcap, smallcap, rest)
  // Higher idx bits = more prominent; sort desc. Fall back to name-length
  // as a tie-breaker so stable ordering.
  pool.sort((a, b) => {
    const ai = a.idx || 0;
    const bi = b.idx || 0;
    if (ai !== bi) return bi - ai;   // reverse of bit-value — higher idx bits = more prominent
    return (a.symbol || "").localeCompare(b.symbol || "");
  });

  // 4) Fallback to full if prefilter killed everything (query is purely
  // qualitative — "defensive dividend payers" with no sector word).
  if (pool.length < 20) {
    pool = full.slice().sort((a, b) => (b.idx || 0) - (a.idx || 0));
  }

  const TOP = 150;
  return pool.slice(0, TOP).map(i => {
    const q2 = quoteCache[i.symbol];
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
      dayPct: q2?.changePct != null ? q2.changePct * 100 : null,
    };
  });
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

function renderStockCard(inst, state, wlSet) {
  // Prefer the rolling intraday buffer built from live polls — falls back
  // to the seeded 40-day walk on cold load before any poll has landed.
  // For Tier-2 symbols (no curated price), the buffer will be empty and
  // sparkline() handles that gracefully.
  const seededCloses = inst.price != null ? getCloses(inst.symbol, 40) : [];
  const closes = getIntradaySparkline(inst.symbol, seededCloses);
  const quote = quoteCache[inst.symbol];
  // LIVE first, always. inst.price is a seeded reference only — used as an
  // initial skeleton placeholder before live data arrives. When the universe
  // scales to all ~2700 NSE stocks, hand-maintaining static prices is
  // impossible, so the UI must tolerate no-static-price gracefully.
  const hasLive = quote?.pricePaise != null;
  const price = hasLive ? quote.pricePaise : (inst.price ?? null);
  const change = quote?.changePct ?? (inst.price != null ? getTodayChange(inst.symbol) : 0);
  // wlSet is hoisted at render time — O(1) membership check; old code used
  // state.watchlist.includes(sym) which was O(n) per card.
  const isWatched = wlSet ? wlSet.has(inst.symbol) : state.watchlist.includes(inst.symbol);
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
    // Stock-specific tooltip. The market-hours explainer already lives on
    // the nav's global market-status pill — no need to duplicate it on
    // every stock card. Here we show information relevant to THIS stock:
    // last closing price, change for the last session, day range, sector,
    // market cap, P/E if available.
    const lblLong = ms.state === "pre-open" ? "Pre-open" : "Closed";
    const rows = [];
    if (hasLive) {
      rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Last close</span><span class="tabular">${formatRupees(price)}</span></div>`);
      rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Change</span><span class="tabular ${deltaClass(change)}">${formatPct(change, { sign: true })}</span></div>`);
      if (quote.high && quote.low && quote.high > 0 && quote.low > 0 && quote.high !== quote.low) {
        rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Day range</span><span class="tabular">${formatRupees(quote.low)} – ${formatRupees(quote.high)}</span></div>`);
      }
    }
    if (inst.sector) {
      rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Sector</span><span>${escapeHtml(inst.sector)}</span></div>`);
    }
    if (inst.marketCap) {
      rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Market cap</span><span>${escapeHtml(inst.marketCap)}</span></div>`);
    }
    if (inst.pe != null && !isNaN(inst.pe)) {
      rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">P/E</span><span class="tabular">${Number(inst.pe).toFixed(1)}</span></div>`);
    }
    const pop = `
      <div class="market-status-pop" role="tooltip">
        <div class="ms-pop-head">
          <span class="ms-pop-label">NSE · ${lblLong}</span>
        </div>
        ${rows.join("")}
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
          ${hasLive || inst.kind === "MF" ? `
            <div class="stock-price tabular">${formatRupees(price)}</div>
            <div class="stock-change ${deltaClass(change)}">${hasLive ? `${formatPct(change, { sign: true })} today` : `<span class="dim">NAV</span>`} ${liveBadge}</div>
          ` : `
            <div class="skeleton" style="width: 96px; height: 20px;" aria-label="Loading price"></div>
            <div class="stock-change" style="display:flex; align-items:center; gap:6px;">
              <span class="skeleton" style="width: 60px; height: 12px;" aria-label="Loading change"></span>
              ${liveBadge}
            </div>
          `}
        </div>
        <span class="risk-pill ${inst.risk || "med"}">${(inst.risk || "MED").toUpperCase()}</span>
      </div>
      <div class="stock-sparkline">${(hasLive || inst.kind === "MF") && closes && closes.length > 1 ? sparkline(closes) : `<div class="skeleton" style="width: 100%; height: 40px;" aria-label="Loading sparkline"></div>`}</div>
    </div>
  `;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
