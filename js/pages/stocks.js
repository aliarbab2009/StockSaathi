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
let _moodFetched = false; // true after first /api/market-mood resolves
let aiSearch = null;          // { matches: ["TCS", ...], rationale: "..." } | null — when present, overrides the normal filter pipeline
let aiSearchLoading = false;
let aiSearchQuery = "";
let aiSearchAbort = null;     // AbortController for the in-flight /api/ai call
let visibleCount = 100;       // pagination window — grows with "Show more"
const PAGE_SIZE = 100;
// Magic-number extraction: how many visible cards the viewport-preheat
// (Hotfix21b) and warm-up-from-observer (Hotfix22a) both fetch up front.
// Set to 60 = ~24 visible cards × 2.5 scroll buffer. Lifted to a named
// const so future changes don't have to hunt for both call sites.
const VIEWPORT_PREHEAT_SIZE = 60;
// 3-second fail-open timeout: if the viewport-preheat batch hasn't
// resolved within this window we drop the skeleton anyway and let the
// post-render warm-up flow fill prices. Prevents a hung upstream API
// from holding the skeleton indefinitely on slow networks.
const PREHEAT_FAIL_OPEN_MS = 3000;
// IntersectionObserver rootMargin values. Hydrate observer uses 200%
// (cards within 2 viewport heights of visible region get warmed up).
// Dehydrate observer uses 600% (cards 6 viewport heights past visible
// get torn back down to stubs to free DOM memory). Both deduced from
// Hotfix7's analysis of "Show all 13,969" leaving 13k hydrated cards.
const HYDRATE_ROOT_MARGIN = "200% 0px 200% 0px";
const DEHYDRATE_ROOT_MARGIN = "600% 0px 600% 0px";
// 2-second fail-open timeout for the mood banner. If the LLM mood call
// is still inflight, drop the gate and let the banner appear later when
// the fetch resolves. Keeps cold loads under the 2s perceived-instant
// threshold even when the mood endpoint is slow.
const MOOD_FAIL_OPEN_MS = 2000;
// Instrument-kind strings. Universe.json uses these as discriminator
// values for stocks.kind. Hoisted to consts so typos at usage sites
// are syntax errors at write time rather than silent never-matches.
const KIND_MF = "MF";
const KIND_EQUITY = "EQUITY";
const KIND_ETF = "ETF";
let _debounceTimer = null;

// Visible-symbols set + observer for viewport-only polling. Populated as
// IntersectionObserver fires; consumed by symbolsToPoll() callback inside
// renderStocks(). Cleared on hashchange leave.
//
// Two observers cooperate:
//   _cardObserver — narrow rootMargin (200%), drives hydration on entry
//                   and viewport-set tracking for live-quote polling.
//   _dehydrateObserver — wide rootMargin (-300% — only fires when the
//                   card is at least 3 viewport heights past the visible
//                   region), restores hydrated cards to stubs to free
//                   DOM memory. Without this, "Show all 13,969" leaves
//                   13k fully-hydrated cards in DOM forever.
let _visibleSymbols = new Set();
let _cardObserver = null;
let _dehydrateObserver = null;

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
  // Tier-2 universe readiness — flipped true the moment universeFull.json
  // has populated getAllInstruments() with thousands of rows. Pre-fix the
  // skeleton-vs-real gate used `allInst.length > STOCKS.length`, which
  // misfired because curated.js still ships 10 placeholder MFs that
  // counted toward `allInst.length` (126 > 116 → "ready" before the
  // 16,665-row universe blob actually landed). User-reported via 5-frame
  // OBS capture: page flashed 116 featured stocks first, then re-rendered
  // alphabetically with the full 2,364-equity universe but no prices yet,
  // then prices arrived, then the mood banner appeared. Each transition
  // was a visible jank step. Proper signal is below — wired in 19c.
  let _universeLoaded = getAllInstruments().length > 1000;
  // First-batch quote readiness — flipped true the moment the warm-up
  // getQuoteBatch() at line ~210 resolves with prices for the initial
  // viewport (cold-start seed = top-30 by index prominence). Without
  // this signal the skeleton would drop the moment universeFull lands
  // (Hotfix19a) but the freshly-rendered cards would still show
  // "Loading…" skeleton bars in their price slots for another 1-3 s
  // until quotes arrived (frame 2 of the OBS capture). Pre-flagged
  // true if quoteCache already covers most of the cold-start seed
  // from getFreshCachedQuotes() — repeat visits within 30 s of the
  // last poll get instant prices and shouldn't artificially gate on
  // a fresh fetch they don't need.
  let _initialQuotesLoaded = false;
  // Mood-banner readiness — flipped true either when fetchMarketMood()
  // resolves with a narrative OR when the 2-second budget expires (the
  // banner is "nice to have" UX; we never want to gate the entire page
  // on a slow LLM call). Pre-fix the mood card appeared 1-2 s after the
  // skeleton dropped, pushing every card on the page down by 90 px and
  // producing the visible layout shift in frame 4 of the OBS capture.
  // Now the skeleton holds until mood is either ready or timed out, so
  // when the real grid renders it does so WITH the mood banner already
  // in place — no shift, no flash.
  let _moodReady = false;
  // Viewport preheat readiness — flipped true once a getQuoteBatch covering
  // the post-universeFull-loaded "top 60 by sort order" symbols has returned.
  // Pre-fix the page rendered the moment universe + cold-start-batch were
  // ready (Hotfix19c) but the cold-start seed was computed against curated
  // (≤126 symbols) BEFORE universeFull loaded. Once the full universe
  // landed, the visible top of the sort changed — cards entering the
  // viewport that weren't in the curated cold-start hydrated as skeleton
  // and only filled in when the warm-up-from-observer batch resolved
  // 1–3 s later. User-reported staircase: skeleton → cards-with-no-prices
  // → cards-with-prices. This flag (wired into the gate by 21b.3) holds
  // the skeleton until quotes for the actual visible viewport are loaded.
  let _viewportPreheatDone = false;
  setTimeout(() => {
    if (!cancelled && !_moodReady) {
      _moodReady = true;
      render();
    }
  }, MOOD_FAIL_OPEN_MS);

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
  // Eager-load MF universe always — cold-load cost is ~250 KB brotli +
  // ~1 s on a fast connection. Without this, the Mutual Funds pill
  // shows "(10)" (legacy placeholder count) until the user clicks
  // the pill, which forces them to click twice to see the real list.
  // User-reported confusing UX: "MF still shows 10 until the pill is
  // clicked". Now the count populates within ~1-2 s of page load.
  ensureMfUniverseLoaded();
  // Also re-render once AMFI lands so the count pills + grid update.
  const onMfLoaded = () => {
    if (cancelled) return;
    // The MF-loaded event re-renders to update the MF count pill in
    // the filter bar. If the page is already showing hydrated cards
    // (likely â€” MF universe is fetched in parallel with stocks
    // universe + cold-start), the render() wipes the grid for what
    // amounts to a count-pill text update. Skip the wipe; the count
    // will surface on the next genuine re-render. Same wasReady
    // guard pattern as 23b/c/d/e.
    const wasReady = pageReady();
    if (!wasReady) render();
  };
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
  // Pre-flag _initialQuotesLoaded true if the fresh-cache already covers
  // a meaningful slice of cold-start symbols. Without this, repeat visits
  // within 30 s of the last poll would gate on a fresh batch they don't
  // need, briefly showing the skeleton even though all the prices the
  // user is about to see are already in cache. Threshold 5 is below the
  // cold-start seed of 30 (line ~200) so we don't accidentally count an
  // empty cache as ready.
  if (Object.keys(quoteCache).length >= 5) _initialQuotesLoaded = true;

  render();
  // Subscribe with a state-slice diff so we only re-render when something
  // RELEVANT to the stocks page changes — watchlist membership, signed-in
  // user, or holdings (for watchlist stars + portfolio P&L tooltips).
  //
  // Pre-fix this listener fired render() on EVERY state emit, including:
  //   - setSetting("coachPanelOpen", true)  — opening the coach FAB
  //   - setSetting("theme", "dark")          — flipping the dark-mode toggle
  //   - recordCoachMessage(msg)              — every coach intro / bias alert
  //   - applyTrade(...)                      — trades placed on detail page
  //   - cross-tab `storage` events           — any tab writing user state
  //
  // Each render() did `main.innerHTML = ...` which wiped every hydrated
  // card back to a skeleton stub, then the IntersectionObserver had to
  // re-fire and re-hydrate everything. That's the user-reported
  // "everything flashing like mad except the name" — the name is in
  // the stub HTML so it survives the wipe; everything else (price,
  // change, sparkline, star, MED pill, CLOSED badge) lives only in
  // the hydrated body and gets re-rendered.
  //
  // The diff captures the small slices of state that actually change
  // grid output. Anything else (settings, coach state, holdings on a
  // different page) is ignored — render() doesn't fire.
  let _lastWlSig = getState().watchlist.join(",");
  let _lastUserSig = getState().user?.id || "";
  let _lastHoldingsSig = JSON.stringify(getState().holdings || {});
  const unsub = subscribe((state) => {
    if (cancelled) return;
    const wlSig = state.watchlist.join(",");
    const userSig = state.user?.id || "";
    // Only stringify holdings keys (symbol list) — full holdings JSON would
    // re-render on every avg-cost recompute. Watchlist needs symbol-set
    // diffing; holdings only matters for "you hold" badges on the cards.
    const holdingsSig = Object.keys(state.holdings || {}).sort().join(",");
    if (wlSig !== _lastWlSig || userSig !== _lastUserSig || holdingsSig !== _lastHoldingsSig) {
      _lastWlSig = wlSig;
      _lastUserSig = userSig;
      _lastHoldingsSig = holdingsSig;
      render();
    }
  });
  // Full universe lands asynchronously — re-render when the loader fires so
  // the instrument count pill and "All NSE" source both pick up Tier 2.
  // Fetch quotes for the top N symbols of the post-universeFull sort
  // order so when the skeleton drops, the visible viewport already has
  // real prices. 60 covers ~24 visible cards × 2.5x scroll buffer. The
  // 3-second timeout ensures a slow upstream API doesn't hold the
  // skeleton indefinitely (fail-open: drop skeleton, prices fill in
  // via warm-up-from-observer as before, just with the visible
  // staircase the user reported — better than infinite skeleton).
  let _viewportPreheatTimer = null;
  function kickViewportPreheat() {
    if (_viewportPreheatDone || cancelled) return;
    const state = getState();
    const top = applyFilters(source(), filter, state, quoteCache).slice(0, VIEWPORT_PREHEAT_SIZE);
    const seed = top.filter(i => i.kind !== KIND_MF).map(i => i.symbol);
    if (seed.length === 0) {
      _viewportPreheatDone = true;
      render();
      return;
    }
    if (_viewportPreheatTimer) clearTimeout(_viewportPreheatTimer);
    _viewportPreheatTimer = setTimeout(() => {
      if (!cancelled && !_viewportPreheatDone) {
        _viewportPreheatDone = true;
        render();
      }
    }, PREHEAT_FAIL_OPEN_MS);
    getQuoteBatch(seed).then(q => {
      if (cancelled) return;
      quoteCache = { ...quoteCache, ...q };
      // Capture readiness BEFORE flipping _viewportPreheatDone — if the
      // fail-open timer beat us to it, the page is already showing the
      // hydrated grid and a render() here would wipe every card.
      const wasReady = pageReady();
      _viewportPreheatDone = true;
      if (_viewportPreheatTimer) { clearTimeout(_viewportPreheatTimer); _viewportPreheatTimer = null; }
      if (wasReady) {
        // Timer fired first. Page already rendered. Patch in the fresh
        // quotes (fp-aware — no DOM rewrite when fingerprints match)
        // instead of re-rendering and wiping the grid.
        patchHydratedCards(q);
      } else {
        render();
      }
    }).catch(() => {
      // fail-open — timer fallback handles this
    });
  }
  // Already-loaded path: if universeFull was loaded by another page or
  // earlier this session, the ss:universe-loaded event won't fire for
  // this mount. Kick the preheat immediately in that case.
  if (_universeLoaded) kickViewportPreheat();
  const onUniverseLoaded = () => {
    if (cancelled) return;
    // Same wasReady guard as the cold-start + preheat callbacks. If
    // _universeLoaded was already true (pre-flagged at mount because
    // INSTRUMENTS already had the full universe from a prior page),
    // the page may already be showing hydrated cards — a render()
    // here would wipe them. Skip the render in that case.
    const wasReady = pageReady();
    _universeLoaded = true;
    if (!wasReady) render();
    kickViewportPreheat();
  };
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
    if (_dehydrateObserver) { try { _dehydrateObserver.disconnect(); } catch {} _dehydrateObserver = null; }
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
        return !inst || inst.kind !== KIND_MF;
      });
    }
    // Cold-start seed: top-30 by index prominence in the current source view.
    const state = getState();
    const list = applyFilters(source(), filter, state, quoteCache).slice(0, 30);
    return list.filter(i => i.kind !== KIND_MF).map(i => i.symbol);
  }

  (async () => {
    try {
      const seed = symbolsToPoll();
      if (!seed.length) return;
      const q = await getQuoteBatch(seed);
      if (cancelled) return;
      quoteCache = { ...quoteCache, ...q };
      // Mark first-batch ready BEFORE rehydrating — the skeleton-vs-real
      // gate (Hotfix19c) re-checks readiness on every render, so flipping
      // this flag first means the next render() call below paints the
      // real grid instead of skeleton. Without this ordering, the gate
      // would still see _initialQuotesLoaded=false at render time even
      // though the quotes are already in quoteCache.
      // Capture readiness BEFORE flipping _initialQuotesLoaded — if the
      // page was already hydrated (Hotfix21b's preheat finished first
      // and rendered the real grid), a render() here would wipe every
      // card back to a stub. User-reported regression after Hotfix22:
      // 'cards load, go skeleton, blink within 300ms, stable'. Skip
      // the wipe and just patch the new quotes into the live DOM.
      const wasReady = pageReady();
      _initialQuotesLoaded = true;
      if (wasReady) {
        // Page is already showing fully-hydrated cards. Patch the new
        // quotes into existing DOM nodes (fp-aware — skips when data
        // unchanged). No render(), no wipe, no blink.
        patchHydratedCards(q);
      } else {
        // Skeleton is still up. Hydrate cards that already exist (rare
        // — usually the grid hasn't been emitted yet) and trigger the
        // skeleton → real grid swap.
        rehydrateCardsInPlace(Object.keys(q));
        render();
      }
    } catch {}
  })();

  pollUnsub = subscribeToQuotes(symbolsToPoll, (quotes) => {
    if (cancelled) return;
    quoteCache = { ...quoteCache, ...quotes };
    // Quote-tick update — patch hydrated cards in place instead of doing a
    // full innerHTML rewrite. The full-rewrite path was wiping the grid
    // every 10 s, dropping the IntersectionObserver bindings, re-emitting
    // stubs, and causing on-screen cards to flash skeleton→hydrated on every
    // tick. patchHydratedCards mutates the live DOM nodes directly: only
    // the price text node, change classlist+text+badge, and sparkline SVG
    // get touched. ~5 ms vs ~80–300 ms for the old path.
    //
    // Exception: when sort=gainers/losers the order depends on live data,
    // so we still need a full re-list to reflect rank changes.
    patchHydratedCards(quotes);
    if (filter.sort === "gainers" || filter.sort === "losers") {
      renderList();
    }
    if (!marketMood && !_moodFetched && Object.keys(quoteCache).length > 30) {
      _moodFetched = true;
      fetchMarketMood().then((m) => {
        if (cancelled) return;
        // Same wasReady guard as the cold-start, preheat, and
        // onUniverseLoaded callbacks. The 2 s mood fail-open timer
        // (line ~148) sets _moodReady=true and triggers a render
        // when the mood fetch is still inflight; if the fetch later
        // resolves, _moodReady is already true and another render()
        // would wipe every hydrated card. Skip the wipe in that case
        // â€” marketMood is now stored in module state and will surface
        // on the next genuine re-render (filter change, etc.).
        const wasReady = pageReady();
        marketMood = m;
        _moodReady = true;
        if (!wasReady) render();
      }).catch(() => {});
    }
  }, 10_000);

  // Patch the price/change/sparkline of hydrated cards in place. Stub cards
  // (not yet scrolled into view) skip — they'll pick up the fresh quote when
  // they hydrate via the IntersectionObserver. CSS.escape handles symbols
  // with `&` (M&M) or `-` (BAJAJ-AUTO) safely.
  function patchHydratedCards(quotes) {
    const host = main.querySelector("#stocks-grid-host");
    if (!host) return;
    const ms = marketStatus();
    for (const sym of Object.keys(quotes)) {
      const sel = `.stock-card[data-sym="${CSS.escape(sym)}"][data-rendered="1"]`;
      const card = host.querySelector(sel);
      if (!card) continue;
      const q = quotes[sym];
      // Detect "card was hydrated as skeleton" — i.e., it has no .stock-price
      // element because hasLive was false at hydration time. patchHydratedCards
      // can't fill in just the price text on such a card; the layout structure
      // is different (skeleton div, not .stock-price + .stock-change). The
      // user-visible bug pre-fix: card showed change% + LIVE badge but NO
      // price (top-row cards in the OBS screenshot). Recovery path: re-render
      // the whole card body in place via rehydrateCardsInPlace, which uses
      // the now-populated quoteCache to emit the correct hasLive=true layout.
      const priceEl = card.querySelector(".stock-price");
      // Skeleton-state guard: if the card is missing .stock-price it was
      // hydrated with hasLive=false (skeleton-shaped body). Two cases:
      //  - We have a price now → re-render the body in place via the
      //    hasLive=true path. rehydrateCardsInPlace replaces the whole
      //    card.innerHTML so the change line + sparkline come along
      //    correctly, no need to fall through.
      //  - We still don't have a price → leave the skeleton as-is. Do NOT
      //    fall through to the change/sparkline updates below; writing
      //    just the change line on a card with no price slot reproduces
      //    the OBS-screenshot bug ("change% + LIVE badge but no price").
      // Invariant after this guard: patchHydratedCards only mutates
      // fully-hydrated cards. Any future quote-source change that emits
      // changePct without pricePaise can't reintroduce the half-broken
      // render.
      if (!priceEl) {
        if (q.pricePaise != null) rehydrateCardsInPlace([sym]);
        continue;
      }
      if (q.pricePaise != null) {
        priceEl.textContent = formatRupees(q.pricePaise);
      }
      const changeEl = card.querySelector(".stock-change");
      if (changeEl && q.changePct != null) {
        // Fingerprint-guarded write — same pattern as the sparkline fix
        // below. Outside market hours getCloses returns identical seeded
        // data, so this skip is hit on >99% of poll ticks.
        //
        // Badge logic now respects market status: CLOSED/PRE-OPEN take
        // precedence over LIVE/DELAYED. Pre-fix patchHydratedCards
        // unconditionally stamped LIVE/DELAYED, overwriting the correct
        // CLOSED badge that had been placed at hydration time. Visible
        // bug in the OBS screenshot: "LIVE" pills displayed on every
        // card while the navbar showed "NSE · Closed 6:29 PM IST".
        const newClass = `stock-change ${deltaClass(q.changePct)}`;
        const fp = computeChangeFp(q.changePct, q.source, q.stale, ms.state);
        if (changeEl.dataset.changeFp !== fp) {
          changeEl.dataset.changeFp = fp;
          changeEl.className = newClass;
          let badge;
          if (ms.state !== "open") {
            const lbl = ms.state === "pre-open" ? "PRE-OPEN" : "CLOSED";
            badge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);">${lbl}</span>`;
          } else if (q.source && q.source !== "mf-static" && q.source !== "synthetic") {
            badge = q.stale
              ? `<span class="pill pill-yellow" style="font-size: 9px; padding: 1px 6px;" title="Stale feed">DELAYED</span>`
              : `<span class="pill pill-green" style="font-size: 9px; padding: 1px 6px;" title="NSE · Live">LIVE</span>`;
          } else {
            badge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Live feed syncing">SYNCING</span>`;
          }
          changeEl.innerHTML = `${formatPct(q.changePct, { sign: true })} today ${badge}`;
        }
      }
      const sparkEl = card.querySelector(".stock-sparkline");
      if (sparkEl) {
        const seededCloses = getCloses(sym, 40);
        const closes = getIntradaySparkline(sym, seededCloses);
        if (closes && closes.length > 1) {
          // Fingerprint-guarded write: cheap length+last-value check skips
          // the innerHTML rewrite when the sparkline data hasn't changed.
          // Pre-fix this ran unconditionally every 10s for every visible
          // card, tearing down + rebuilding the SVG DOM subtree even when
          // closes was byte-identical to last tick. Result: every card
          // visibly re-painted on every quote tick — user-reported as
          // "cards near the top keep flashing/blinking like mad". Outside
          // market hours getCloses returns identical seeded data, so this
          // skip is hit on >99% of poll ticks.
          const fp = `${closes.length}:${closes[closes.length - 1]}`;
          if (sparkEl.dataset.sparkFp !== fp) {
            sparkEl.dataset.sparkFp = fp;
            sparkEl.innerHTML = sparkline(closes);
          }
        }
      }
    }
  }

  // Re-render the inner body of specific cards in place, without wiping
  // the grid. Used when the warm-up batch (initial mount + IO first-fire)
  // returns quotes for cards that were already hydrated in skeleton state
  // (because quoteCache was empty at hydration time). Replacing card.innerHTML
  // preserves the outer wrapper — IO observations stay intact, scroll
  // position is preserved, no chain-reaction of re-hydrations.
  //
  // Pre-fix: warm-up callbacks called renderList() which wiped #stocks-grid-host
  // entirely. That re-emitted all stubs, re-attached observers, fired IO
  // for visible cards which hydrated them again, then quote tick patched.
  // ~5 round-trips per cycle, ~5x re-hydrations per visible card during
  // scroll = continuous user-visible flashing + scroll position resets.
  function rehydrateCardsInPlace(syms) {
    if (!Array.isArray(syms) || !syms.length) return;
    const host = main.querySelector("#stocks-grid-host");
    if (!host) return;
    const state = getState();
    const wlSet = new Set(state.watchlist);
    const ms = marketStatus();
    for (const sym of syms) {
      if (!sym) continue;
      const card = host.querySelector(`.stock-card[data-sym="${CSS.escape(sym)}"]`);
      if (!card) continue;
      const inst = getInstrument(sym);
      if (!inst) continue;
      const seededCloses = getCloses(sym, 40);
      const closes = getIntradaySparkline(sym, seededCloses);
      const quote = quoteCache[sym];
      const hasLive = quote?.pricePaise != null;
      const navFallbackPaise = (inst.kind === KIND_MF && typeof inst.nav === "number" && inst.nav > 0)
        ? Math.round(inst.nav * 100)
        : null;
      const price = hasLive ? quote.pricePaise : navFallbackPaise;
      const change = quote?.changePct ?? getTodayChange(sym);
      const isWatched = wlSet.has(sym);
      let liveBadge;
      if (inst.kind === KIND_MF) {
        liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Mutual Fund NAV">NAV</span>`;
      } else if (ms.state !== "open") {
        const lbl = ms.state === "pre-open" ? "PRE-OPEN" : "CLOSED";
        liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);">${lbl}</span>`;
      } else if (quote?.source && quote.source !== "mf-static" && quote.source !== "synthetic") {
        liveBadge = quote.stale
          ? `<span class="pill pill-yellow" style="font-size: 9px; padding: 1px 6px;">DELAYED</span>`
          : `<span class="pill pill-green" style="font-size: 9px; padding: 1px 6px;" title="NSE · Live">LIVE</span>`;
      } else {
        liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Live feed syncing">SYNCING</span>`;
      }
      // Pre-compute the change-line fingerprint so the first quote-tick
      // after this rehydrate is a fingerprint hit in patchHydratedCards
      // (no innerHTML rebuild on identical content). Mirrors data-spark-fp.
      const changeFp = inst.kind === KIND_MF ? null : computeChangeFp(change, quote?.source, quote?.stale, ms.state);
      card.innerHTML = renderStockCardBody(inst, state, wlSet, {
        closes, hasLive, price, change, isWatched, liveBadge, changeFp,
      });
      card.dataset.stub = "";
      card.dataset.rendered = "1";
      card.classList.remove("stock-card-stub");
    }
  }

  // Site-wide skeleton state shown during the brief window between page
  // mount and universeFull.json arriving. Replaces the previous behaviour
  // where the page would flash 116 featured stocks first then re-render
  // with the full 16,655-instrument universe. Skeleton is more honest:
  // "we're loading" instead of "here's a different page that's about to
  // change". Re-renders to the real layout once `ss:universe-loaded`
  // fires (already wired via the existing onUniverseLoaded listener).
  function renderSkeletonState() {
    const skelCard = `<div class="stock-card stock-card-stub" style="min-height: 172px; pointer-events: none;">
      <div class="stock-head">
        <div class="stock-avatar skeleton" style="width: 32px; height: 32px;"></div>
        <div class="stock-title">
          <div class="skeleton" style="width: 140px; height: 14px;"></div>
          <div class="skeleton" style="width: 80px; height: 10px; margin-top: 6px;"></div>
        </div>
      </div>
      <div class="skeleton" style="width: 96px; height: 20px; margin-top: 8px;"></div>
      <div class="skeleton" style="width: 70px; height: 12px; margin-top: 6px;"></div>
      <div class="skeleton" style="width: 100%; height: 40px; margin-top: 8px;"></div>
    </div>`;
    const skelPill = (w) => `<span class="filter-pill skeleton" style="width: ${w}px; height: 32px; display: inline-block; border-radius: 16px;"></span>`;
    const skelSectorPill = (w) => `<span class="filter-pill skeleton" style="width: ${w}px; height: 28px; display: inline-block; border-radius: 14px;"></span>`;
    main.innerHTML = `
      <div class="flex items-start justify-between wrap gap-3" style="margin-bottom: var(--sp-4);">
        <div>
          <h1>Markets</h1>
          <p class="muted"><span class="skeleton" style="width: 240px; height: 14px; display: inline-block; vertical-align: middle;"></span></p>
        </div>
        <span class="data-badge"><span class="dot offline"></span> Loading…</span>
      </div>
      <div class="stocks-toolbar">
        <div class="input-prefix">
          <span class="px">🔍</span>
          <input type="search" placeholder="Loading markets…" disabled style="opacity: 0.6;" />
        </div>
        <span class="skeleton" style="width: 110px; height: 32px; border-radius: 8px; display: inline-block;"></span>
        <span class="skeleton" style="width: 200px; height: 38px; border-radius: 8px; display: inline-block;"></span>
      </div>
      <div class="filter-pills" style="margin-bottom: var(--sp-3);">
        ${[100, 70, 130, 110].map(skelPill).join("")}
      </div>
      <div class="filter-pills" style="margin-bottom: var(--sp-5); max-height: 88px; overflow-y: hidden;">
        ${[80, 60, 90, 75, 100, 65, 85, 70, 95, 80, 105, 70].map(skelSectorPill).join("")}
      </div>
      <div class="stocks-grid">
        ${Array(12).fill(skelCard).join("")}
      </div>
    `;
  }

  // Single source of truth for "is the grid currently showing hydrated cards
  // (vs. the loading skeleton)?" Used by render() to choose between
  // renderSkeletonState() and the full grid emit, AND by every
  // late-resolving callback that calls render() to decide whether
  // to skip a redundant render that would wipe hydrated cards.
  function pageReady() {
    return _universeLoaded && _initialQuotesLoaded && _viewportPreheatDone && _moodReady;
  }

  function render() {
    const state = getState();
    const wlSet = new Set(state.watchlist);
    const allInst = getAllInstruments();
    // Use the boolean tracked at function scope (set true by onUniverseLoaded
    // event listener OR pre-flagged at mount when allInst > 1000 already).
    // The previous `allInst.length > STOCKS.length` heuristic was off by 10
    // because curated.js's PLACEHOLDER_MFS still get included in allInst at
    // pre-universeFull state.
    const universeReady = _universeLoaded;
    // Page is "real-grid ready" only when ALL of (a) the full universe has
    // landed (b) the cold-start quote batch has resolved (c) the viewport
    // preheat (Hotfix21b) has resolved or failed-open (d) the mood banner
    // is ready or failed-open. Collapses several intermediate frames into
    // a single skeleton state — the page either shows skeleton (waiting)
    // or shows fully-priced cards (ready).
    const isReady = pageReady();

    // Pre-universe-loaded: emit a full-page skeleton instead of the
    // 116-featured "real" view that briefly flashed in pre-Hotfix12. The
    // user-visible delta was confusing — the page would render with
    // ACC/ADANIENT/ADANIGREEN... for ~1 s, then re-render with the full
    // 16,655-instrument universe. Skeleton state is more honest about
    // "we're still loading" and matches the design language users
    // already see on stub cards.
    if (!isReady) {
      renderSkeletonState();
      return;
    }

    const fullList = applyFilters(source(), filter, state, quoteCache);
    const list = fullList.slice(0, visibleCount);
    const truncated = fullList.length > list.length;
    const src = getDataSource();
    const allSectorsList = getAllSectors();
    // Tab counts — derived from the full universe (all kinds), not the
    // filtered list. Shows "..." until Tier-2 lands.
    const equityCount = universeReady ? allInst.filter(i => i.kind === KIND_EQUITY).length : null;
    const etfCount    = universeReady ? allInst.filter(i => i.kind === KIND_ETF).length : null;
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
      ` : filter.kind === "ETF" ? `
        <!-- ETF tab: equity-sector pills are useless here (every ETF row has
             sector="ETF", so any "Banking"/"Pharma"/etc. pill click yields 0
             results). Hide entirely. ETF category pills (Equity Index / Gold /
             Liquid / International) would need build-time enrichment that
             ships in a follow-up. -->
      ` : `
        <div class="filter-pills" style="margin-bottom: var(--sp-5); max-height: 88px; overflow-y: auto;">
          <button class="filter-pill ${filter.sector === "all" ? "active" : ""}" data-sector="all">All sectors</button>
          ${allSectorsList.map(s => `<button class="filter-pill ${filter.sector === s ? "active" : ""}" data-sector="${escapeAttr(s)}">${escapeHtml(s)}</button>`).join("")}
        </div>
      `}

      <div id="stocks-grid-host">${list.length === 0
        ? `<div class="empty-state"><span class="emoji">🔍</span><h3>No matches</h3><p>Try clearing a filter or searching differently.</p></div>`
        : `<div class="stocks-grid">${list.map(inst => renderStubCard(inst)).join("")}</div>${truncated ? `<div class="flex justify-center stocks-pager" style="margin-top: var(--sp-4); gap: 8px; flex-wrap: wrap;"><button class="btn btn-ghost" id="stocks-show-more">Show ${Math.min(PAGE_SIZE, fullList.length - list.length)} more (${fullList.length - list.length} remaining)</button><button class="btn btn-ghost" id="stocks-show-all">Show all ${fullList.length}</button></div>` : ""}`}</div>
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
    // Event delegation — ONE click listener on the grid host instead of
    // 2N listeners (card click + watchlist toggle) per card. At 2,364 stocks
    // this drops 4,728 listener attachments to 1, eliminating the 4-6 s
    // main-thread freeze "Show all" used to cause on mid-Android.
    attachGridDelegation(main.querySelector("#stocks-grid-host"));
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
  //
  // Chunked render: when visibleCount > CHUNK_THRESHOLD, we render the grid
  // in 200-stub batches with a requestAnimationFrame yield between batches.
  // Without this, "Show all 2,364" on Stocks held the main thread for ~10 s
  // (user-reported), and "Show all 13,969" on Mutual Funds triggered the
  // browser's "Tab not responding" warning. Each 200-stub batch parses in
  // ~20 ms and the RAF yield lets the browser paint what's there before the
  // next batch lands — user sees progressive fill instead of 10 s blank.
  const CHUNK_SIZE = 200;
  const CHUNK_THRESHOLD = 300;   // sub-300 lists render synchronously
  let _renderListSeq = 0;        // monotonic — cancels stale chunked renders
  async function renderList() {
    const mySeq = ++_renderListSeq;
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
    if (list.length === 0) {
      host.innerHTML = `<div class="empty-state"><span class="emoji">🔍</span><h3>No matches</h3><p>Try clearing a filter or searching differently.</p></div>`;
      attachGridDelegation(host);
      attachCardObserver(host);
      return;
    }
    // Build the pager footer string once — same for sync and chunked paths.
    const pagerHtml = truncated
      ? `<div class="flex justify-center stocks-pager" style="margin-top: var(--sp-4); gap: 8px; flex-wrap: wrap;">
          <button class="btn btn-ghost" id="stocks-show-more">Show ${Math.min(PAGE_SIZE, fullList.length - list.length)} more (${fullList.length - list.length} remaining)</button>
          <button class="btn btn-ghost" id="stocks-show-all">Show all ${fullList.length}</button>
        </div>`
      : "";

    if (list.length <= CHUNK_THRESHOLD) {
      // Synchronous path — small lists render in one shot.
      host.innerHTML = `<div class="stocks-grid">${list.map(inst => renderStubCard(inst)).join("")}</div>${pagerHtml}`;
      attachGridDelegation(host);
      attachCardObserver(host);
    } else {
      // Chunked path — render the first batch immediately so users see
      // SOMETHING within ~20 ms of clicking, then progressively fill.
      host.innerHTML = `<div class="stocks-grid"></div><div id="stocks-loading-indicator" class="dim text-xs center" style="margin: var(--sp-4) 0; padding: var(--sp-3);">Loading ${list.length.toLocaleString("en-IN")} stubs…</div>`;
      const grid = host.querySelector(".stocks-grid");
      // Wire the click delegation + create the IO once UP FRONT (with no
      // cards yet — observe-list starts empty). Then we incrementally
      // observe each chunk's cards as they're rendered. This is the key
      // ordering: if we called attachCardObserver at the END instead, it
      // would disconnect+recreate the IO and the cards in earlier chunks
      // would lose their observation between final render and final IO
      // setup, leaving them un-hydratable.
      attachGridDelegation(host);
      attachCardObserver(host);   // creates IO, observes nothing (grid empty)
      let rendered = 0;
      while (rendered < list.length) {
        // Bail out if a newer renderList() supersedes this one (e.g. user
        // changed sort/filter mid-render). Without this, two concurrent
        // chunked renders would interleave in the same grid.
        if (mySeq !== _renderListSeq || cancelled) return;
        const slice = list.slice(rendered, rendered + CHUNK_SIZE);
        const tmp = document.createElement("div");
        tmp.innerHTML = slice.map(inst => renderStubCard(inst)).join("");
        const frag = document.createDocumentFragment();
        const newCards = [];
        while (tmp.firstChild) {
          newCards.push(tmp.firstChild);
          frag.appendChild(tmp.firstChild);
        }
        grid.appendChild(frag);
        // Observe the just-appended cards so the IO can hydrate them on
        // scroll-into-view even before the full render finishes. Both
        // observers (hydrate + dehydrate) need to see every card.
        for (const card of newCards) {
          if (card?.dataset?.sym) {
            try { _cardObserver?.observe(card); } catch {}
            try { _dehydrateObserver?.observe(card); } catch {}
          }
        }
        rendered += CHUNK_SIZE;
        // Yield to the browser. RAF runs once per frame (~16 ms at 60 Hz),
        // so each chunk gets a fresh frame to paint into. Total time for
        // 13,969 MFs is ~70 chunks × ~16 ms = ~1.1 s of progressive fill —
        // the user sees stubs appearing in waves instead of a frozen tab,
        // and Chrome no longer fires the "Tab not responding" popup.
        if (rendered < list.length) {
          await new Promise(r => requestAnimationFrame(r));
        }
      }
      // Remove the loading indicator and append the pager footer.
      host.querySelector("#stocks-loading-indicator")?.remove();
      if (pagerHtml) host.insertAdjacentHTML("beforeend", pagerHtml);
    }
    host.querySelector("#stocks-show-more")?.addEventListener("click", () => { visibleCount += PAGE_SIZE; renderList(); });
    host.querySelector("#stocks-show-all")?.addEventListener("click", () => { visibleCount = fullList.length; renderList(); });
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
    // Tear down both observers — DOM nodes from the prior render are gone,
    // and disconnect() leaves the entry list dangling otherwise.
    if (_cardObserver) {
      try { _cardObserver.disconnect(); } catch {}
      _cardObserver = null;
    }
    if (_dehydrateObserver) {
      try { _dehydrateObserver.disconnect(); } catch {}
      _dehydrateObserver = null;
    }
    _visibleSymbols.clear();
    // Reset the one-shot warm-up flag — without this, every tab switch
    // (Stocks → ETFs → Mutual Funds → Watchlist) skips the immediate
    // first-paint getQuoteBatch and users wait the full 10s subscribeToQuotes
    // cycle for prices. Visible regression on prod: ETF cards stayed in the
    // skeleton-stuck state (gray bars where price should be) for 10s after
    // tab activation. Resetting here means the next IO callback's
    // !_warmedFromObserver branch fires fresh for the new viewport batch.
    _warmedFromObserver = false;
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
      const state = getState();
      const wlSet = new Set(state.watchlist);
      for (const entry of entries) {
        const card = entry.target;
        const sym = card?.dataset?.sym;
        if (!sym) continue;
        if (entry.isIntersecting) {
          if (!_visibleSymbols.has(sym)) { _visibleSymbols.add(sym); changed = true; }
          // Hydrate the stub on first intersect. card.dataset.stub === "1"
          // means we're still showing the skeleton; swap in the full body.
          // Subsequent intersects (after un/re-intersect during scroll) skip
          // because dataset.stub has been cleared.
          if (card.dataset.stub === "1") {
            const inst = getInstrument(sym);
            if (inst) {
              // Defensive: if a non-MF card enters viewport without a
              // live quote in cache (covers the long tail beyond the
              // 21b viewport preheat — symbols user scrolls into after
              // the initial 60), skip the hydrate-as-skeleton path
              // entirely. The warm-up-from-observer batch fires below
              // when the IO callback's `changed` flag flips true; once
              // its quote arrives, rehydrateCardsInPlace renders this
              // card directly into the hasLive=true layout. Net user
              // experience: stub → fully-priced card in one transition,
              // never the intermediate "hydrated with skeleton price"
              // state. MFs short-circuit through this guard via
              // inst.nav fallback so they always hydrate immediately.
              const _q = quoteCache[sym];
              if (inst.kind !== KIND_MF && _q?.pricePaise == null) {
                continue;
              }
              const seededCloses = getCloses(sym, 40);
              const closes = getIntradaySparkline(sym, seededCloses);
              const quote = _q;
              const hasLive = quote?.pricePaise != null;
              // MF NAV fallback (see same logic in renderStockCardBody) —
              // MFs never poll a live quote so the card body must read
              // inst.nav directly to show a real price.
              const navFallbackPaise = (inst.kind === KIND_MF && typeof inst.nav === "number" && inst.nav > 0)
                ? Math.round(inst.nav * 100)
                : null;
              const price = hasLive ? quote.pricePaise : navFallbackPaise;
              const change = quote?.changePct ?? getTodayChange(sym);
              const isWatched = wlSet.has(sym);
              const ms = marketStatus();
              let liveBadge;
              if (inst.kind === KIND_MF) {
                liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Mutual Fund NAV">NAV</span>`;
              } else if (ms.state !== "open") {
                const lbl = ms.state === "pre-open" ? "PRE-OPEN" : "CLOSED";
                liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);">${lbl}</span>`;
              } else if (quote?.source && quote.source !== "mf-static" && quote.source !== "synthetic") {
                liveBadge = quote.stale
                  ? `<span class="pill pill-yellow" style="font-size: 9px; padding: 1px 6px;">DELAYED</span>`
                  : `<span class="pill pill-green" style="font-size: 9px; padding: 1px 6px;" title="NSE · Live">LIVE</span>`;
              } else {
                liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Live feed syncing">SYNCING</span>`;
              }
              // Pre-compute the change-line fingerprint for first-tick
              // no-op (mirrors data-spark-fp). MFs skip — patchHydratedCards
              // never patches MF change lines (MFs aren't in symbolsToPoll).
              const changeFp = inst.kind === KIND_MF ? null : computeChangeFp(change, quote?.source, quote?.stale, ms.state);
              card.innerHTML = renderStockCardBody(inst, state, wlSet, {
                closes, hasLive, price, change, isWatched, liveBadge, changeFp,
              });
              card.dataset.stub = "";
              card.dataset.rendered = "1";
              card.classList.remove("stock-card-stub");
            }
          }
        } else {
          if (_visibleSymbols.has(sym)) { _visibleSymbols.delete(sym); changed = true; }
        }
      }
      // First-paint nudge: as soon as the initial entries fire, kick a quote
      // batch for whatever's actually on screen so the user sees real prices
      // within ~200ms instead of waiting for the 10s poll cycle.
      if (changed && _visibleSymbols.size > 0 && !_warmedFromObserver) {
        _warmedFromObserver = true;
        // Only fetch symbols MISSING from quoteCache. Pre-fix the warm-up
        // batch always re-fetched every visible symbol, which after the
        // Hotfix21b viewport preheat meant a redundant round-trip for
        // 24-60 cards that already had fresh quotes — and the resulting
        // rehydrate produced a visible card-grid blink ~200 ms after
        // the page settled. User-reported: 'graph and prices on the
        // card again blink after the page loads'. Filtering to misses
        // skips the round-trip entirely when the preheat already
        // covers the viewport (typical case post-21b).
        const seed = Array.from(_visibleSymbols).filter(s => {
          const inst = getInstrument(s);
          if (inst?.kind === KIND_MF) return false;
          return !quoteCache[s]?.pricePaise;
        }).slice(0, VIEWPORT_PREHEAT_SIZE);
        if (seed.length) {
          getQuoteBatch(seed).then(q => {
            if (cancelled) return;
            quoteCache = { ...quoteCache, ...q };
            // patchHydratedCards is fingerprint-aware: cards whose price
            // and change-line haven't changed skip the innerHTML rewrite
            // entirely. Pre-fix this called rehydrateCardsInPlace which
            // unconditionally rebuilt every card's body — visible blink
            // ~200 ms after the page settled even when the data was
            // identical to what the preheat had already loaded.
            // patchHydratedCards detects skeleton-state cards (those
            // missing .stock-price after a stub-only emit) and falls
            // back to rehydrateCardsInPlace([sym]) for those, so cards
            // beyond the preheat still get their full hydrate path.
            patchHydratedCards(q);
          }).catch(() => {});
        }
      }
    }, {
      root: null,                     // viewport
      rootMargin: HYDRATE_ROOT_MARGIN,
      threshold: 0,
    });

    // Dehydrate observer — restores hydrated cards back to stubs when
    // they're at least 6 viewport heights past the visible region.
    //
    // Pre-Hotfix7 used `rootMargin: "-300% 0px -300% 0px"` thinking it
    // would shrink the root and use isIntersecting=false as the
    // "far away" signal. That math is broken: a viewport (height H)
    // shrunk by 300% top + 300% bottom = -5H = a NEGATIVE-sized
    // rectangle. Per the IO spec, every observed element reports
    // isIntersecting:false against a zero-or-negative-sized root.
    // Result: every card gets dehydrated immediately after hydration.
    //
    //   Stocks tab → top cards "kept flashing" (hydrate→dehydrate→
    //                hydrate cycle on every IO callback).
    //   ETFs / MFs → cards never escape the skeleton state because the
    //                buggy IO instant-dehydrates anything just hydrated.
    //
    // Correct semantics: use a LARGE POSITIVE rootMargin (600% on top
    // and bottom = 6 viewports of grace zone above + below) and the
    // SAME `!entry.isIntersecting` trigger. Now the root is HUGE — only
    // cards that fall OUTSIDE the wide zone (i.e., 6+ viewports past
    // the visible viewport) report isIntersecting=false. The grace
    // zone of 4 viewports between hydrate-margin (200%) and dehydrate-
    // margin (600%) means cards stay hydrated even after scrolling
    // a few viewports past the hydrate trigger.
    //
    // Memory math unchanged: 13,969 cards × 30 KB = 420 MB if all
    // hydrated; after dehydration kicks in for far cards, we hold
    // ~25-50 hydrated × 30 KB = ~1.5 MB. Long sessions stay bounded.
    if (typeof IntersectionObserver === "function") {
      _dehydrateObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const card = entry.target;
          // With rootMargin "600% 0px", isIntersecting:false means the
          // card is OUTSIDE the 13-viewport-tall expanded root box —
          // i.e., 6+ viewport heights above or below visible. Safe to
          // dehydrate without disrupting anything the user can see.
          if (!entry.isIntersecting && card.dataset.rendered === "1") {
            const sym = card.dataset.sym;
            const inst = sym ? getInstrument(sym) : null;
            if (!inst) continue;
            card.innerHTML = `
              <div class="stock-head">
                <div class="stock-avatar">${escapeHtml(inst.logo || inst.symbol.slice(0, 3))}</div>
                <div class="stock-title">
                  <div class="name">${escapeHtml(inst.name)}</div>
                  <div class="sym">${_stubSubLine(inst)}</div>
                </div>
              </div>
              <div class="skeleton" style="width: 96px; height: 20px; margin-top: 6px;" aria-label="Loading price"></div>
              <div class="skeleton" style="width: 70px; height: 12px; margin-top: 6px;" aria-label="Loading change"></div>
              <div class="skeleton" style="width: 100%; height: 40px; margin-top: 8px;" aria-label="Loading sparkline"></div>
            `;
            card.dataset.stub = "1";
            card.dataset.rendered = "";
            card.classList.add("stock-card-stub");
          }
        }
      }, {
        root: null,
        rootMargin: DEHYDRATE_ROOT_MARGIN,
        threshold: 0,
      });
    }

    host.querySelectorAll(".stock-card[data-sym]").forEach(card => {
      try { _cardObserver.observe(card); } catch {}
      try { _dehydrateObserver?.observe(card); } catch {}
    });
  }

  // Single delegated click handler on the grid host. Replaces 2N per-card
  // listeners (card click + watchlist toggle) with ONE listener that bubbles
  // events up and dispatches via .closest(). At 2,364 stocks: 4,728 → 1,
  // a 99.98% reduction in listener objects. Kills the 4-6 s "Show all" freeze.
  // Uses host.onclick = ... so re-calls cleanly replace prior bindings (no
  // double-fire on re-render).
  function attachGridDelegation(host) {
    if (!host) return;
    host.onclick = (e) => {
      // Watchlist toggle wins over card-click — handle it first and stop.
      const wlBtn = e.target.closest(".watchlist-toggle");
      if (wlBtn) {
        e.stopPropagation();
        const sym = wlBtn.dataset.sym;
        if (!sym) return;
        const wl = new Set(getState().watchlist);
        const wasWatched = wl.has(sym);
        // In-place DOM patch BEFORE the state mutation — fast visual feedback
        // and avoids relying on the subscribe re-render path. The subscribe
        // diff in renderStocks() will detect the watchlist change and call
        // render() but the user already sees the star flip immediately
        // here, so no perceived lag.
        wlBtn.textContent = wasWatched ? "☆" : "★";
        wlBtn.title = wasWatched ? "Add to watchlist" : "Remove from watchlist";
        wlBtn.setAttribute("aria-label", wasWatched ? "Add" : "Remove");
        if (wasWatched) removeFromWatchlist(sym);
        else addToWatchlist(sym);
        return;
      }
      const card = e.target.closest(".stock-card[data-sym]");
      if (card && card.dataset.sym) {
        location.hash = "#/stocks/" + card.dataset.sym;
      }
    };
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
    if (f.kind === "EQUITY") list = list.filter(i => i.kind === KIND_EQUITY);
    else if (f.kind === "ETF") list = list.filter(i => i.kind === KIND_ETF);
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
  if (f.kind === "EQUITY") list = list.filter(i => i.kind === KIND_EQUITY);
  else if (f.kind === "ETF") list = list.filter(i => i.kind === KIND_ETF);
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
    //
    // ETF prominence boost: every ETF row ships with idx=0 because
    // build-universe.mjs only computes index membership for Nifty equity
    // indices. Without this boost, ETFs sorted alphabetically and the most
    // popular ones (NIFTYBEES, GOLDBEES, BANKBEES, JUNIORBEES, LIQUIDBEES)
    // were buried hundreds of rows deep behind no-name "AB..." schemes.
    // Bump these well-known tickers up via a hand-curated boost table.
    // Real fix needs AUM ingestion in the build script — this is the
    // stopgap until that lands.
    const ETF_PROMINENCE = {
      NIFTYBEES: 100, GOLDBEES: 95, BANKBEES: 90, JUNIORBEES: 85,
      LIQUIDBEES: 80, SETFNIF50: 75, KOTAKLIQ: 70, ICICILIQ: 65,
      CPSEETF: 60, ITBEES: 55, PSUBNKBEES: 50, SHARIABEES: 45,
      MIDCAP150: 65, NIFTYIETF: 70, SETFNN50: 60, NIF100IETF: 60,
      SILVERBEES: 65, SETFGOLD: 50,
    };
    list.sort((a, b) => {
      let ai = a.idx || a.idx_tags || 0;
      let bi = b.idx || b.idx_tags || 0;
      if (a.kind === "ETF") ai = ETF_PROMINENCE[a.symbol] || ai;
      if (b.kind === "ETF") bi = ETF_PROMINENCE[b.symbol] || bi;
      if (ai !== bi) return bi - ai;
      return (a.symbol || "").localeCompare(b.symbol || "");
    });
  }
  return list;
}

// ── Stub card — minimal HTML emitted at first paint for every row ──────────
// Pre-Hotfix4: clicking "Show all 2,364" rendered every card fully-hydrated
// into a single innerHTML write (~1.4 MB string + 4,728 attached listeners),
// stalling the main thread for 4–6 s on mid-range Android. Now we ship
// stubs instead — ~200 chars apiece, no listeners, fixed layout box —
// and the IntersectionObserver in attachCardObserver() upgrades each
// stub to a full card body the moment it scrolls into view (200% root
// margin, so users never see the skeleton flash on a typical scroll).
//
// `min-height: 172px` preserves the layout box so the IO doesn't get
// confused by zero-height rows and so the user's scroll position stays
// consistent through the hydrate transition.
// Format the symbol-line subtitle so MF cards show "AMC · Category" instead
// of "MF_118718 · Equity" (technical AMFI code looks like garbage to users).
// Equities/ETFs keep their existing "SYMBOL · Sector" layout.
function _stubSubLine(inst) {
  if (inst.kind === KIND_MF) {
    // AMC short name (first 2 words) is more recognisable than MF_<code>.
    // category_bucket is set to inst.sector by universeLoader, but use
    // category_bucket explicitly here in case sector ever ships differently.
    const amcShort = inst.amc
      ? escapeHtml(inst.amc.split(/\s+/).slice(0, 2).join(" "))
      : escapeHtml(inst.symbol);
    const cat = inst.category_bucket || inst.sector;
    return cat && cat !== "Unknown" ? `${amcShort} · ${escapeHtml(cat)}` : amcShort;
  }
  const sectorBit = inst.sector && inst.sector !== "Unknown" ? ` · ${escapeHtml(inst.sector)}` : "";
  return `${escapeHtml(inst.symbol)}${sectorBit}`;
}

function renderStubCard(inst) {
  return `<div class="stock-card stock-card-stub" data-sym="${inst.symbol}" data-stub="1" role="button" tabindex="0" aria-label="${escapeAttr(inst.name)}" style="min-height: 172px;">
    <div class="stock-head">
      <div class="stock-avatar">${escapeHtml(inst.logo || inst.symbol.slice(0, 3))}</div>
      <div class="stock-title">
        <div class="name">${escapeHtml(inst.name)}</div>
        <div class="sym">${_stubSubLine(inst)}</div>
      </div>
    </div>
    <div class="skeleton" style="width: 96px; height: 20px; margin-top: 6px;" aria-label="Loading price"></div>
    <div class="skeleton" style="width: 70px; height: 12px; margin-top: 6px;" aria-label="Loading change"></div>
    <div class="skeleton" style="width: 100%; height: 40px; margin-top: 8px;" aria-label="Loading sparkline"></div>
  </div>`;
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
  // MF NAV fallback: MFs never get a live quote (they're filtered out of
  // symbolsToPoll() because Yahoo has no MF intraday data). Without this
  // fallback the card showed "—" + "NAV NAV" — visible nonsense.
  // inst.nav is rupees from AMFI; convert to paise so formatRupees works.
  const navFallbackPaise = (inst.kind === KIND_MF && typeof inst.nav === "number" && inst.nav > 0)
    ? Math.round(inst.nav * 100)
    : null;
  const price = hasLive ? quote.pricePaise : navFallbackPaise;
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
  if (inst.kind === KIND_MF) {
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
    <div class="stock-card" data-sym="${inst.symbol}" data-rendered="1" role="button" tabindex="0" aria-label="${escapeAttr(inst.name)}">
      ${renderStockCardBody(inst, state, wlSet, { closes, hasLive, price, change, isWatched, liveBadge, changeFp: inst.kind === KIND_MF ? null : computeChangeFp(change, quote?.source, quote?.stale, marketStatus().state) })}
    </div>
  `;
}

// Inner HTML of a hydrated stock card. Extracted from renderStockCard so the
// IntersectionObserver hot path can do `card.innerHTML = renderStockCardBody(...)`
// and turn a stub into a full card without re-creating the outer wrapper
// (preserves the click-target, focus, and `data-sym` attribute the event-
// delegation handler reads).
//
// The opts object carries the heavy-to-recompute values from renderStockCard
// when we're going through the full path; on the IO hot path we pass null
// and recompute internally so this can also be called fresh from hydrateCard.
function renderStockCardBody(inst, state, wlSet, opts = null) {
  let closes, hasLive, price, change, isWatched, liveBadge;
  if (opts) {
    ({ closes, hasLive, price, change, isWatched, liveBadge } = opts);
  } else {
    const seededCloses = getCloses(inst.symbol, 40);
    closes = getIntradaySparkline(inst.symbol, seededCloses);
    const quote = (typeof window !== "undefined" && window.__ssQuoteCache) ? window.__ssQuoteCache[inst.symbol] : null;
    hasLive = quote?.pricePaise != null;
    price = hasLive ? quote.pricePaise : null;
    change = quote?.changePct ?? getTodayChange(inst.symbol);
    isWatched = wlSet ? wlSet.has(inst.symbol) : (state?.watchlist || []).includes(inst.symbol);
    const ms = marketStatus();
    if (inst.kind === KIND_MF) {
      liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Mutual Fund NAV — refreshed once per day after market close">NAV</span>`;
    } else if (ms.state !== "open") {
      const lbl = ms.state === "pre-open" ? "PRE-OPEN" : "CLOSED";
      liveBadge = `<span class="pill stock-card-ms-pill market-status" tabindex="0" data-ms-state="${ms.state}" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);">${lbl}</span>`;
    } else if (quote?.source && quote.source !== "mf-static" && quote.source !== "synthetic") {
      liveBadge = quote.stale
        ? `<span class="pill pill-yellow" style="font-size: 9px; padding: 1px 6px;">DELAYED</span>`
        : `<span class="pill pill-green" style="font-size: 9px; padding: 1px 6px;" title="NSE · Live">LIVE</span>`;
    } else {
      liveBadge = `<span class="pill" style="font-size: 9px; padding: 1px 6px; background: var(--bg-subtle); color: var(--text-dim);" title="Live feed syncing">SYNCING</span>`;
    }
  }
  return `
    <div class="stock-head">
      <div class="stock-avatar">${escapeHtml(inst.logo || inst.symbol.slice(0, 3))}</div>
      <div class="stock-title">
        <div class="name">${escapeHtml(inst.name)}</div>
        <div class="sym">${_stubSubLine(inst)}</div>
      </div>
      <button class="watchlist-toggle" data-sym="${inst.symbol}" title="${isWatched ? "Remove from watchlist" : "Add to watchlist"}" aria-label="${isWatched ? "Remove" : "Add"}" style="background: transparent; padding: 4px; font-size: 16px;">${isWatched ? "★" : "☆"}</button>
    </div>
    <div class="flex items-center justify-between">
      <div>
        ${hasLive || inst.kind === KIND_MF ? `
          <div class="stock-price tabular">${formatRupees(price)}</div>
          <div class="stock-change ${deltaClass(change)}"${opts?.changeFp ? ` data-change-fp="${escapeAttr(opts.changeFp)}"` : ""}>${hasLive ? `${formatPct(change, { sign: true })} today` : `<span class="dim">NAV</span>`} ${liveBadge}</div>
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
    <div class="stock-sparkline"${closes && closes.length > 1 ? ` data-spark-fp="${closes.length}:${closes[closes.length - 1]}"` : ""}>${closes && closes.length > 1 ? sparkline(closes) : `<div class="skeleton" style="width: 100%; height: 40px;" aria-label="Loading sparkline"></div>`}</div>
  `;
}

// Stock-card change-line fingerprint. Used by the patchHydratedCards
// re-render guard (read side) AND — once 21a.2/21a.3 land — by every
// caller that emits a fresh card body via renderStockCardBody (write
// side). Both sides compute identical fingerprints from identical
// inputs, so the first quote-tick after initial render becomes a
// fingerprint hit → no innerHTML rebuild → no DOM teardown → no
// flash. Mirrors the data-spark-fp contract introduced in Hotfix20a.
//
// Output format must stay byte-identical between the read and write
// paths or every first-tick will miss the guard and re-paint
// silently. Format: `${changePct.toFixed(4)}|${badgeKey}|stock-change <delta>`
function computeChangeFp(changePct, source, stale, msState) {
  const newClass = `stock-change ${deltaClass(changePct)}`;
  const badgeKey = msState !== "open"
    ? `closed:${msState}`
    : (source && source !== "mf-static" && source !== "synthetic" ? `live:${stale ? "1" : "0"}` : "syncing");
  return `${(changePct ?? 0).toFixed(4)}|${badgeKey}|${newClass}`;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
