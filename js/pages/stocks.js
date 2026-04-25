// =============================================================================
// STOCKS — Browse markets. Real-time prices via Yahoo Finance when possible.
// =============================================================================

import { STOCKS, MUTUAL_FUNDS, SECTORS, INSTRUMENTS, getAllInstruments, getAllSectors, getInstrument, ensureUniverseLoaded, ensureMfUniverseLoaded, getMfCategoryBuckets } from "../data/universe.js";
import { getTodayChange, getCloses, marketStatus } from "../data/prices.js";
import { getQuoteBatch, getDataSource, subscribeToQuotes, getCachedQuotes, getFreshCachedQuotes, getIntradaySparkline } from "../data/marketData.js";
import { sparkline } from "../components/charts.js";
import { formatRupees, formatPct, deltaClass } from "../money.js";
import { getState, addToWatchlist, removeFromWatchlist, subscribe } from "../state.js";
import { toast } from "../components/toast.js";

// Default tab = Stocks (showing the full universe sorted by index prominence
// — Nifty 50/100 stocks naturally land on top). No Featured/All split.
// `mfBucket` and `mfPlan` are MF-tab-only filters — preserved across tab
// switches so coming back to Mutual Funds keeps the user's last view.
let filter = { q: "", sector: "all", kind: "EQUITY", sort: "marketCap", mfBucket: "all", mfPlan: "all" };
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

// Visible-symbols set + observer for viewport-only polling. Populated as
// IntersectionObserver fires; consumed by symbolsToPoll() callback inside
// renderStocks(). Cleared on hashchange leave.
let _visibleSymbols = new Set();
let _cardObserver = null;

// Keywords that let the Ask-Saathi prefilter narrow a 2k-candidate pool down
// to ~150 without sending everything to the LLM. Maps lowercase tokens to
// filter predicates applied against the full-universe row shape.
const CAP_KEYWORDS = {
  largecap: ["mega", "large"], "large cap": ["mega", "large"], "large-cap": ["mega", "large"],
  "tier 1": ["mega", "large"], "tier1": ["mega", "large"], "top tier": ["mega", "large"],
  midcap: ["mid"], "mid cap": ["mid"], "mid-cap": ["mid"],
  "tier 2": ["mid"], "tier2": ["mid"], "second tier": ["mid"],
  smallcap: ["small", "micro"], "small cap": ["small", "micro"], "small-cap": ["small", "micro"],
  "low cap": ["small", "micro"], "low-cap": ["small", "micro"],
  microcap: ["micro"], "micro cap": ["micro"], "micro-cap": ["micro"],
  penny: ["micro"], "penny stock": ["micro"],
  bluechip: ["mega"], "blue chip": ["mega"], "blue-chip": ["mega"],
  nifty50: ["mega"], "nifty 50": ["mega"], "top 50": ["mega"], "top 100": ["mega", "large"],
};
const RISK_KEYWORDS = {
  safe: "low", stable: "low", defensive: "low", steady: "low",
  conservative: "low", boring: "low", "low risk": "low", "low-risk": "low",
  risky: "high", volatile: "high", speculative: "high", aggressive: "high",
  punt: "high", "high risk": "high", "high-risk": "high", momentum: "high",
  moderate: "med", balanced: "med", "medium risk": "med",
};

export function renderStocks(main) {
  let cancelled = false;
  let pollUnsub = null;
  // One-shot flag — first batch of viewport-visible symbols triggers an
  // immediate getQuoteBatch so users see prices instantly. Subsequent
  // scroll changes piggy-back on the 10s subscribeToQuotes cycle.
  let _warmedFromObserver = false;

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
  // If the user lands on the Mutual Funds tab from a deep-link or a previous
  // session, eager-load AMFI's catalog so the grid populates without a
  // second click. Otherwise we defer until tab activation to keep cold-load
  // payload small (~600 KB brotli).
  if (filter.kind === "MF") ensureMfUniverseLoaded();
  // Also re-render once AMFI lands so the count pills + grid update.
  const onMfLoaded = () => { if (!cancelled) render(); };
  window.addEventListener("ss:mf-universe-loaded", onMfLoaded);

  // Single source: the full merged Tier-1 + Tier-2 universe (~2700 rows).
  // No Featured / All-NSE distinction — the kind pill (Stocks / ETFs / MFs /
  // Watchlist) decides which slice the user sees, and the default sort by
  // index prominence (Nifty 50/100 first) puts the famous names on top
  // organically. This matches Groww / Zerodha Kite / Upstox UX.
  function source() {
    return getAllInstruments();
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
    window.removeEventListener("ss:mf-universe-loaded", onMfLoaded);
    if (aiSearchAbort) { try { aiSearchAbort.abort(); } catch {} aiSearchAbort = null; }
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
    if (_cardObserver) { try { _cardObserver.disconnect(); } catch {} _cardObserver = null; }
    _visibleSymbols.clear();
  };
  window.addEventListener("hashchange", onLeave, { once: true });

  // Viewport-only polling. At 2,700+ universe symbols, polling all of them
  // every 10s would burn the Vercel function budget AND saturate Yahoo's
  // rate limits AND uselessly fetch quotes for cards the user can't see.
  // The visible-symbols Set is populated by an IntersectionObserver wired
  // in renderList() / render() (see attachCardObserver below). The poll
  // callback reads the snapshot each tick. On cold load (before any card
  // has rendered) we seed with the top-30 by idx prominence so users see
  // real prices on the first row of cards immediately.
  _visibleSymbols = new Set();
  function symbolsToPoll() {
    if (_visibleSymbols.size > 0) {
      // Only poll EQUITY/ETF symbols — MFs have no real-time feed.
      return Array.from(_visibleSymbols).filter(s => {
        const inst = getInstrument(s);
        return !inst || inst.kind !== "MF";
      });
    }
    // Cold-start seed: top-30 by index prominence in the current source view.
    const state = getState();
    const list = applyFilters(source(), filter, state, quoteCache).slice(0, 30);
    return list.filter(i => i.kind !== "MF").map(i => i.symbol);
  }

  (async () => {
    try {
      const seed = symbolsToPoll();
      if (!seed.length) return;
      const q = await getQuoteBatch(seed);
      if (cancelled) return;
      quoteCache = { ...quoteCache, ...q };
      renderList();
    } catch {}
  })();

  pollUnsub = subscribeToQuotes(symbolsToPoll, (quotes) => {
    if (cancelled) return;
    quoteCache = { ...quoteCache, ...quotes };
    // Quote-tick update: ONLY the stock-card grid is re-rendered. The
    // toolbar (search input + themed-select sort dropdown) and filter pills
    // stay in place — this kills the "blink" where the sort dropdown flashed
    // on every 10-second tick because the entire main.innerHTML was rebuilt.
    renderList();
    if (!marketMood && !_moodFetched && Object.keys(quoteCache).length > 30) {
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
    const wlSet = new Set(state.watchlist);
    const fullList = applyFilters(source(), filter, state, quoteCache);
    const list = fullList.slice(0, visibleCount);
    const truncated = fullList.length > list.length;
    const src = getDataSource();
    const allInst = getAllInstruments();
    const allSectorsList = getAllSectors();
    // Tab counts — derived from the full universe (all kinds), not the
    // filtered list. Shows "..." until Tier-2 lands.
    const universeReady = allInst.length > STOCKS.length;
    const equityCount = universeReady ? allInst.filter(i => i.kind === "EQUITY").length : null;
    const etfCount    = universeReady ? allInst.filter(i => i.kind === "ETF").length : null;
    const mfCount     = universeReady ? allInst.filter(i => i.kind === "MF").length : null;
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
        <button class="filter-pill ${filter.kind === "EQUITY" ? "active" : ""}" data-kind="EQUITY">Stocks${equityCount ? ` (${equityCount})` : ""}</button>
        <button class="filter-pill ${filter.kind === "ETF" ? "active" : ""}" data-kind="ETF">ETFs${etfCount ? ` (${etfCount})` : ""}</button>
        <button class="filter-pill ${filter.kind === "MF" ? "active" : ""}" data-kind="MF">Mutual Funds${mfCount ? ` (${mfCount})` : ""}</button>
        <button class="filter-pill ${filter.kind === "watchlist" ? "active" : ""}" data-kind="watchlist">★ Watchlist (${state.watchlist.length})</button>
      </div>
      ${filter.kind === "MF" ? `
        <div class="filter-pills" style="margin-bottom: var(--sp-3); max-height: 88px; overflow-y: auto;">
          <button class="filter-pill ${filter.mfBucket === "all" ? "active" : ""}" data-mfbucket="all">All categories</button>
          ${getMfCategoryBuckets().map(b => `<button class="filter-pill ${filter.mfBucket === b ? "active" : ""}" data-mfbucket="${escapeAttr(b)}">${escapeHtml(b)}</button>`).join("")}
        </div>
        <div class="filter-pills" style="margin-bottom: var(--sp-5);">
          <button class="filter-pill ${filter.mfPlan === "all" ? "active" : ""}" data-mfplan="all">All plans</button>
          <button class="filter-pill ${filter.mfPlan === "Direct" ? "active" : ""}" data-mfplan="Direct" title="Direct plans have a lower expense ratio because no distributor commission is built in">Direct</button>
          <button class="filter-pill ${filter.mfPlan === "Regular" ? "active" : ""}" data-mfplan="Regular" title="Regular plans pay a distributor commission embedded in the expense ratio">Regular</button>
        </div>
      ` : `
        <div class="filter-pills" style="margin-bottom: var(--sp-5); max-height: 88px; overflow-y: auto;">
          <button class="filter-pill ${filter.sector === "all" ? "active" : ""}" data-sector="all">All sectors</button>
          ${allSectorsList.map(s => `<button class="filter-pill ${filter.sector === s ? "active" : ""}" data-sector="${escapeAttr(s)}">${escapeHtml(s)}</button>`).join("")}
        </div>
      `}

      <div id="stocks-grid-host">${list.length === 0
        ? `<div class="empty-state"><span class="emoji">🔍</span><h3>No matches</h3><p>Try clearing a filter or searching differently.</p></div>`
        : `<div class="stocks-grid">${list.map(inst => renderStockCard(inst, state, wlSet)).join("")}</div>${truncated ? `<div class="flex justify-center stocks-pager" style="margin-top: var(--sp-4); gap: 8px; flex-wrap: wrap;"><button class="btn btn-ghost" id="stocks-show-more">Show ${Math.min(PAGE_SIZE, fullList.length - list.length)} more (${fullList.length - list.length} remaining)</button><button class="btn btn-ghost" id="stocks-show-all">Show all ${fullList.length}</button></div>` : ""}`}</div>
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
    main.querySelectorAll("[data-mfbucket]").forEach(btn => btn.addEventListener("click", () => { filter.mfBucket = btn.dataset.mfbucket; visibleCount = PAGE_SIZE; render(); }));
    main.querySelectorAll("[data-mfplan]").forEach(btn => btn.addEventListener("click", () => { filter.mfPlan = btn.dataset.mfplan; visibleCount = PAGE_SIZE; render(); }));
    main.querySelectorAll("[data-kind]").forEach(btn => btn.addEventListener("click", () => {
      filter.kind = btn.dataset.kind;
      filter.sector = "all";      // sector list changes between Stocks / ETFs / MFs / Watchlist
      visibleCount = PAGE_SIZE;
      // First click on Mutual Funds — kick the AMFI catalog fetch so the
      // grid populates with all ~14k schemes. Subsequent clicks are no-op
      // because ensureMfUniverseLoaded de-dupes via _mfLoadPromise.
      if (filter.kind === "MF") ensureMfUniverseLoaded();
      render();
    }));
    // Show more / Show all rebuild only the grid (renderList) — no need to
    // tear down the toolbar + themed-select on every pagination click.
    main.querySelector("#stocks-show-more")?.addEventListener("click", () => { visibleCount += PAGE_SIZE; renderList(); });
    main.querySelector("#stocks-show-all")?.addEventListener("click", () => { visibleCount = 1e9; renderList(); });
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
    attachCardObserver(main.querySelector("#stocks-grid-host"));

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
      : `<div class="stocks-grid">${list.map(inst => renderStockCard(inst, state, wlSet)).join("")}</div>${truncated ? `<div class="flex justify-center stocks-pager" style="margin-top: var(--sp-4); gap: 8px; flex-wrap: wrap;"><button class="btn btn-ghost" id="stocks-show-more">Show ${Math.min(PAGE_SIZE, fullList.length - list.length)} more (${fullList.length - list.length} remaining)</button><button class="btn btn-ghost" id="stocks-show-all">Show all ${fullList.length}</button></div>` : ""}`;
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
    attachCardObserver(host);
  }

  // Viewport-aware observer. Drives both:
  //   1) Which symbols get polled by subscribeToQuotes (symbolsToPoll callback
  //      reads _visibleSymbols).
  //   2) Future virtualization hooks — the ratio crossing already maps onto
  //      "hydrate / dehydrate this card".
  // rootMargin "200% 0px 200% 0px" — pre-warms quotes for cards 2 viewport
  // heights above and below, so by the time the user scrolls them in, they
  // already have a live tick. Naturally responds to user resolution + zoom
  // (the browser computes intersection against the actual viewport box, not
  // a fixed pixel count).
  // threshold 0 — any pixel of the card visible within rootMargin counts.
  function attachCardObserver(host) {
    if (!host) return;
    // Tear down the previous observer — DOM nodes from the prior render are
    // gone, and disconnect() leaves the entry list dangling otherwise.
    if (_cardObserver) {
      try { _cardObserver.disconnect(); } catch {}
      _cardObserver = null;
    }
    _visibleSymbols.clear();
    if (typeof IntersectionObserver !== "function") {
      // Old browsers (or SSR test harness) — fall back to seeding all visible
      // symbols up front. The prefilter inside symbolsToPoll() then trims to
      // EQUITY/ETF only and the cold-start branch caps at 30.
      host.querySelectorAll(".stock-card[data-sym]").forEach(c => {
        if (c.dataset.sym) _visibleSymbols.add(c.dataset.sym);
      });
      return;
    }
    _cardObserver = new IntersectionObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const sym = entry.target?.dataset?.sym;
        if (!sym) continue;
        if (entry.isIntersecting) {
          if (!_visibleSymbols.has(sym)) { _visibleSymbols.add(sym); changed = true; }
        } else {
          if (_visibleSymbols.has(sym)) { _visibleSymbols.delete(sym); changed = true; }
        }
      }
      // First-paint nudge: as soon as the initial entries fire, kick a quote
      // batch for whatever's actually on screen so the user sees real prices
      // within ~200ms instead of waiting for the 10s poll cycle.
      if (changed && _visibleSymbols.size > 0 && !_warmedFromObserver) {
        _warmedFromObserver = true;
        const seed = Array.from(_visibleSymbols).filter(s => {
          const inst = getInstrument(s);
          return !inst || inst.kind !== "MF";
        }).slice(0, 60);
        if (seed.length) {
          getQuoteBatch(seed).then(q => {
            if (cancelled) return;
            quoteCache = { ...quoteCache, ...q };
            renderList();
          }).catch(() => {});
        }
      }
    }, {
      root: null,                     // viewport
      rootMargin: "200% 0px 200% 0px",
      threshold: 0,
    });
    host.querySelectorAll(".stock-card[data-sym]").forEach(card => {
      try { _cardObserver.observe(card); } catch {}
    });
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
  // Broader keyword → sector aliases that NSE doesn't name directly.
  // NOTE: each value MUST be a sector string that actually exists in the
  // universe (curated.js + universeFull.json). Banking/Pharma/Insurance are
  // curated-only — Tier-2 banks fall back to "Other" so the keyword still
  // helps narrow the curated subset.
  const SECTOR_ALIASES = {
    bank: "Banking", banks: "Banking", banking: "Banking", psu: "Banking",
    pharma: "Pharma", pharmaceutical: "Pharma", drug: "Pharma", medicine: "Pharma",
    it: "IT Services", tech: "IT Services", software: "IT Services", saas: "IT Services",
    auto: "Auto", car: "Auto", motor: "Auto", vehicle: "Auto", "ev": "Auto", "electric vehicle": "Auto",
    fmcg: "FMCG", consumer: "Consumer", "consumer goods": "FMCG",
    "consumer electronics": "Consumer Elec", appliance: "Consumer Elec", electronic: "Consumer Elec",
    metal: "Metals", steel: "Metals", aluminium: "Metals", copper: "Metals", mining: "Metals",
    oil: "Energy", gas: "Energy", energy: "Energy", petroleum: "Energy", refinery: "Energy",
    power: "Power", electric: "Power", utility: "Power", utilities: "Power", renewable: "Power", solar: "Power",
    realty: "Real Estate", "real estate": "Real Estate", property: "Real Estate", housing: "Real Estate",
    cement: "Cement",
    telecom: "Telecom", mobile: "Telecom", "5g": "Telecom",
    insurance: "Insurance",
    finance: "NBFC", nbfc: "NBFC", lending: "NBFC", financial: "NBFC", financier: "NBFC",
    chemical: "Chemicals", specialty: "Chemicals",
    fertilizer: "Chemicals", fertiliser: "Chemicals", agro: "Chemicals", agri: "Chemicals",
    paint: "Chemicals", agrochemical: "Chemicals",
    infrastructure: "Construction", infra: "Construction",
    construction: "Construction", builder: "Construction", "epc": "Construction",
    shipping: "Services", shipyard: "Services", port: "Services", logistics: "Services",
    courier: "Services", warehouse: "Services", transport: "Services", "supply chain": "Services",
    media: "Services", broadcaster: "Services", entertainment: "Services",
    travel: "Services", hotel: "Services", hospitality: "Services", tourism: "Services",
    airline: "Services", aviation: "Services",
    retail: "Services", ecommerce: "Services", internet: "Services",
    healthcare: "Healthcare", hospital: "Healthcare", diagnostic: "Healthcare", clinic: "Healthcare",
    diversified: "Conglomerate", conglomerate: "Conglomerate",
    etf: "ETF", "exchange traded": "ETF", "index fund": "ETF",
  };
  for (const [kw, sec] of Object.entries(SECTOR_ALIASES)) {
    if (q.includes(kw)) sectorHints.add(sec);
  }

  // 1b) Parse numeric hints — "PE < 30", "P/E under 20", "yield > 2%", "yield over 3",
  //     "beta below 1". These are precise signals the LLM has to otherwise
  //     infer from the table — turning them into hard filters cuts the
  //     candidate pool, lifts result quality, and stops wasting the model's
  //     reasoning budget on arithmetic.
  const numHints = parseNumericHints(q);
  // "cheap" / "expensive" qualitative cues map to PE/PB ranges so a query
  // like "cheap pharma" filters with PE<=18 instead of relying on the LLM.
  if (numHints.peMax == null && /\b(cheap|undervalued|low pe|low p\/e|value)\b/.test(q)) {
    numHints.peMax = 18;
  }
  if (numHints.peMin == null && /\b(expensive|overvalued|premium|growth|growth stock)\b/.test(q)) {
    numHints.peMin = 35;
  }
  // "dividend payers" / "high dividend" / "income" — the LLM is bad at
  // numeric comparisons across 150 rows; pin it.
  if (numHints.divMin == null && /\b(dividend payer|dividend payers|high dividend|high yield|income stock|income stocks|payer)\b/.test(q)) {
    numHints.divMin = 1.5;
  }

  // 2) Prefilter
  let pool = full;
  if (sectorHints.size) pool = pool.filter(i => sectorHints.has(i.sector));
  if (capHints.size) pool = pool.filter(i => capHints.has(byCap.get(i.symbol)));
  if (riskHints.size) pool = pool.filter(i => riskHints.has(i.risk || "med"));
  // Numeric filters are tolerant: rows missing the field pass through (Tier-2
  // typically has null pe/pb/divYield) so we don't over-prune the universe.
  if (numHints.peMax != null)  pool = pool.filter(i => i.pe == null || i.pe <= numHints.peMax);
  if (numHints.peMin != null)  pool = pool.filter(i => i.pe == null || i.pe >= numHints.peMin);
  if (numHints.divMin != null) pool = pool.filter(i => i.divYield == null || i.divYield >= numHints.divMin);
  if (numHints.betaMax != null) pool = pool.filter(i => i.beta == null || i.beta <= numHints.betaMax);

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
    const row = {
      symbol: i.symbol,
      name: i.name,
      sector: i.sector || "",
      pe: i.pe ?? null,
      pb: i.pb ?? null,
      divYield: i.divYield ?? null,
      beta: i.beta ?? null,
      risk: i.risk || "",
      dayPct: q2?.changePct != null ? q2.changePct * 100 : null,
    };
    // Only include marketCap when populated (curated rows). Tier-2 rows ship
    // it as "" — sending an empty field for ~140 rows wastes ~280 tokens
    // for nothing.
    if (i.marketCap) row.marketCap = i.marketCap;
    return row;
  });
}

// Pulls "PE < 30", "P/E under 20", "yield > 2%", "beta below 1.2" etc. out
// of a free-text query. Returns an object with {peMin, peMax, divMin,
// betaMax} where each is a number or undefined. Bounds are clamped to
// sensible ranges so a typo can't silently kill the candidate pool.
function parseNumericHints(q) {
  const out = {};
  const num = (s) => { const n = Number(s); return isFinite(n) ? n : null; };
  // PE: "pe < 30", "p/e under 20", "pe below 25", "pe over 40"
  const peLt = q.match(/p\/?e\s*(?:<|under|below|less than|max|<=)\s*(\d+(?:\.\d+)?)/);
  if (peLt) { const n = num(peLt[1]); if (n != null && n > 0 && n < 500) out.peMax = n; }
  const peGt = q.match(/p\/?e\s*(?:>|over|above|greater than|more than|min|>=)\s*(\d+(?:\.\d+)?)/);
  if (peGt) { const n = num(peGt[1]); if (n != null && n >= 0 && n < 500) out.peMin = n; }
  // Yield: "yield > 2", "yield over 3%", "dividend > 2"
  const dyGt = q.match(/(?:yield|dividend)\s*(?:>|over|above|min|greater than|more than|>=)\s*(\d+(?:\.\d+)?)/);
  if (dyGt) { const n = num(dyGt[1]); if (n != null && n >= 0 && n < 50) out.divMin = n; }
  // Beta: "beta < 1", "beta below 1.2"
  const beLt = q.match(/beta\s*(?:<|under|below|less than|max|<=)\s*(\d+(?:\.\d+)?)/);
  if (beLt) { const n = num(beLt[1]); if (n != null && n > 0 && n < 5) out.betaMax = n; }
  return out;
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
    else if (f.kind === "ETF") list = list.filter(i => i.kind === "ETF");
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
  else if (f.kind === "ETF") list = list.filter(i => i.kind === "ETF");
  else if (f.kind === "MF") {
    list = list.filter(i => i.kind === "MF");
    // MF-specific facets: category bucket (Equity/Debt/Hybrid/Index/etc.)
    // and plan type (Direct/Regular). Both default to "all".
    if (f.mfBucket && f.mfBucket !== "all") {
      list = list.filter(i => i.category_bucket === f.mfBucket);
    }
    if (f.mfPlan && f.mfPlan !== "all") {
      list = list.filter(i => i.plan_type === f.mfPlan);
    }
  }
  else if (f.kind === "watchlist") {
    const wl = new Set(state.watchlist);
    list = list.filter(i => wl.has(i.symbol));
  }
  // Sector filter only applies outside MF mode (MFs use mfBucket).
  if (f.kind !== "MF" && f.sector !== "all") list = list.filter(i => i.sector === f.sector);
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
  else if (f.sort === "name") list.sort((a, b) => (a.name || a.symbol || "").localeCompare(b.name || b.symbol || ""));
  else if (f.sort === "marketCap") {
    // Sort by index-membership prominence (Nifty 50 > Nifty 100 > Nifty 500 >
    // Mid150 > Small250 > rest). Pre-Landing-F we used parseMarketCapCr on
    // hand-typed marketCap strings; those fields are now null per the
    // user's "zero hand-typed data" rule. idx_tags is computed at build time
    // from index constituents (build-universe.mjs) and is the closest proxy
    // to "size" we have without an LLM-token-burning live fundamentals
    // call per card. Tie-break by symbol so order is stable.
    list.sort((a, b) => {
      const ai = a.idx || a.idx_tags || 0;
      const bi = b.idx || b.idx_tags || 0;
      if (ai !== bi) return bi - ai;
      return (a.symbol || "").localeCompare(b.symbol || "");
    });
  }
  return list;
}

function renderStockCard(inst, state, wlSet) {
  // Always pull the deterministic seeded walk from prices.js — it has a
  // Tier-2 stub-fallback that produces a believable per-symbol synthetic
  // chart even when there's no live quote yet. The intraday buffer
  // overlays once subscribeToQuotes lands a tick. Drops the previous
  // `inst.price != null` gate that left ALL Tier-2 cards with empty
  // sparklines forever (the gate was a vestige of the hand-typed era).
  const seededCloses = getCloses(inst.symbol, 40);
  const closes = getIntradaySparkline(inst.symbol, seededCloses);
  const quote = quoteCache[inst.symbol];
  const hasLive = quote?.pricePaise != null;
  const price = hasLive ? quote.pricePaise : null;
  const change = quote?.changePct ?? getTodayChange(inst.symbol);
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
    if (inst.sector && inst.sector !== "Unknown") {
      rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Sector</span><span>${escapeHtml(inst.sector)}</span></div>`);
    }
    if (inst.cap_bucket || inst.capBucket) {
      const cap = inst.cap_bucket || inst.capBucket;
      const capLabel = { mega: "Mega cap", large: "Large cap", mid: "Mid cap", small: "Small cap", micro: "Micro cap" }[cap] || cap;
      rows.push(`<div class="ms-pop-row"><span class="ms-pop-key">Cap</span><span>${escapeHtml(capLabel)}</span></div>`);
    }
    // Note: PE / Market Cap / Beta / DivYield no longer come from inst.* —
    // they are fetched on-demand from /api/fundamentals when the user opens
    // the stock detail page. Showing them here would require firing 100+
    // /api/fundamentals calls per Markets render, which kills latency. The
    // grid card stays minimal; the detail page does the heavier lookup.
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
  } else {
    // No live quote yet (Tier-2 cold load before subscribeToQuotes ticks
    // in viewport range). Show a generic SYNCING badge — sparkline still
    // renders from the seeded stub walk so the card isn't blank.
    badge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Live feed syncing — sparkline shows deterministic synthetic walk until first quote tick">SYNCING</span>`;
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
      <div class="stock-sparkline">${closes && closes.length > 1 ? sparkline(closes) : `<div class="skeleton" style="width: 100%; height: 40px;" aria-label="Loading sparkline"></div>`}</div>
    </div>
  `;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
