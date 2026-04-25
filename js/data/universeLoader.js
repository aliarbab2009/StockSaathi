// =============================================================================
// UNIVERSE LOADER — full Tier-2 universeFull.json + featured-symbol projection.
//
// Zero hand-typed data. Every field comes from automated builds:
//   - Symbol list, name, sector, series, ISIN: build-universe.mjs (NSE +
//     NiftyIndices CSVs) → universeFull.json
//   - market_cap / PE / PB / beta / divYield / EPS: /api/fundamentals
//     (Yahoo crumb + Tickertape, cached in Supabase fundamentals_cache)
//   - Price / OHLC / 52W: /api/quote, /api/history (Yahoo v8/chart)
//
// Sync API (getInstrument / STOCKS / INSTRUMENTS / SECTORS / INSTRUMENT_BY_SYMBOL)
// stays valid from module-load onwards. Before universeFull.json lands,
// FEATURED_SYMBOLS resolve to minimal stubs; after the JSON loads, the
// projection upgrades to full Tier-2 rows + ss:universe-loaded fires so
// pages can re-render with the proper sector / risk / industry tags.
// =============================================================================

import { FEATURED_SYMBOLS, FEATURED_MF_CODES, PLACEHOLDER_MFS, ONBOARDING_PORTFOLIOS } from "./curated.js";

export { ONBOARDING_PORTFOLIOS, FEATURED_SYMBOLS, FEATURED_MF_CODES };

// ── Mutable module-scoped state ─────────────────────────────────────────────
let _fullBySymbol = null;          // populated after ensureUniverseLoaded resolves
let _mfBySymbol = null;            // populated after AMFI mfFull.json lands
let _mergedBySymbol = null;        // lazy: full ∪ MF placeholders ∪ AMFI MFs
let _sectorsCache = null;          // lazy: union of sectors
let _categoriesCache = null;       // lazy: MF category bucket list
let _loadPromise = null;           // de-dupes concurrent ensureUniverseLoaded calls
let _mfLoadPromise = null;         // de-dupes concurrent ensureMfUniverseLoaded calls

// ── Bootstrap stubs (until universeFull.json lands) ────────────────────────
// At cold load FEATURED_SYMBOLS resolve to minimal stubs. Once the JSON
// loads they get replaced with full Tier-2 rows. Kind defaults to EQUITY.
function _bareStub(symbol, kind = "EQUITY") {
  return {
    symbol,
    name: symbol,
    sector: kind === "MF" ? null : "Unknown",
    kind,
    risk: "med",
    logo: symbol.slice(0, 3),
    price: null,
    marketCap: null,
    pe: null,
    pb: null,
    divYield: null,
    beta: null,
    _stub: true,
  };
}

const _placeholderMfsByS = Object.fromEntries(
  PLACEHOLDER_MFS.map(m => [m.symbol, { ...m, kind: "MF", _placeholder: true }])
);

// ── Public sync exports (live bindings — re-read after universe-loaded) ─────
// `let` so we can swap in upgraded values when Tier-2 lands.

/** Featured-symbol projection. Initially stubs; upgraded to full Tier-2 rows
 *  after universeFull.json loads. */
export let STOCKS = FEATURED_SYMBOLS.map(s => _bareStub(s, "EQUITY"));

/** Mutual funds — placeholders until Landing G ships AMFI's full ~5,000-
 *  scheme catalog. */
export let MUTUAL_FUNDS = PLACEHOLDER_MFS.map(m => ({ ...m, kind: "MF" }));

/** Combined featured + placeholder MFs. Equivalent to old `INSTRUMENTS`. */
export let INSTRUMENTS = [...STOCKS, ...MUTUAL_FUNDS];

/** Symbol → instrument map. Live binding so callers reading after
 *  universe-loaded see fresh data. */
export let INSTRUMENT_BY_SYMBOL = Object.fromEntries(
  INSTRUMENTS.map(i => [i.symbol, i])
);

/** Sector list for the curated view (featured + MF placeholders).
 *  After Tier-2 loads, getAllSectors() returns the broader union. */
export let SECTORS = [...new Set(STOCKS.map(s => s.sector).filter(s => s && s !== "Unknown"))].sort();

// ── Resolve a single symbol to its richest available instrument record ──────
export function getInstrument(symbol) {
  if (!symbol || typeof symbol !== "string") return null;
  // 1) AMFI catalog (MF_<scheme code> primary key — wins over the placeholder
  //    list when both are loaded, since AMFI ships richer metadata).
  if (_mfBySymbol && _mfBySymbol[symbol]) return _mfBySymbol[symbol];
  // 2) Tier 2 equity universe (lazy-loaded NSE + ETF rows).
  if (_fullBySymbol && _fullBySymbol[symbol]) return _fullBySymbol[symbol];
  // 3) MF placeholder (kept for ONBOARDING_PORTFOLIOS symbols only — these
  //    are the legacy 10 hand-typed scheme codes that onboarding starter
  //    portfolios reference. Real AMFI codes use the (1) branch.)
  if (_placeholderMfsByS[symbol]) return _placeholderMfsByS[symbol];
  // 4) Stub — pages render stub-tolerant skeletons + kick Tier-3 enrichment
  return _bareStub(symbol, symbol.startsWith("MF_") ? "MF" : "EQUITY");
}

// ── Lazy load Tier-2 + upgrade the bootstrap stubs ──────────────────────────
export function ensureUniverseLoaded() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const res = await fetch("./js/data/universeFull.json", { cache: "default" });
      if (!res.ok) return false;
      const rows = await res.json();
      if (!Array.isArray(rows)) return false;

      const byS = {};
      for (const r of rows) {
        if (!r || !r.symbol) continue;
        byS[r.symbol] = {
          kind: r.kind || "EQUITY",
          // No hand-typed defaults — these come from /api/fundamentals
          // when the user opens a stock detail page or scrolls a card
          // into view. Cards render skeleton until live data lands.
          price: null,
          marketCap: null,
          pe: null,
          pb: null,
          divYield: null,
          beta: null,
          logo: r.symbol.slice(0, 3),
          ...r,
        };
      }
      _fullBySymbol = byS;
      _mergedBySymbol = null;
      _sectorsCache = null;

      // Upgrade the boot-stub exports in place — live bindings means importers
      // see the new arrays on next access.
      STOCKS = FEATURED_SYMBOLS
        .map(s => byS[s] || _bareStub(s, "EQUITY"));
      INSTRUMENTS = [...STOCKS, ...MUTUAL_FUNDS];
      INSTRUMENT_BY_SYMBOL = Object.fromEntries(
        INSTRUMENTS.map(i => [i.symbol, i]).concat(
          // Also expose every Tier-2 row for direct lookup
          Object.entries(byS)
        )
      );
      SECTORS = [...new Set(
        STOCKS.map(s => s.sector).filter(s => s && s !== "Unknown")
      )].sort();

      // Notify subscribers (stocks.js, stockDetail.js, coach panels) so they
      // can re-render with proper sectors + Tier-2 names.
      try {
        window.dispatchEvent(new CustomEvent("ss:universe-loaded", { detail: { count: rows.length } }));
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  })();
  return _loadPromise;
}

// ── Lazy load AMFI mutual-fund universe ─────────────────────────────────────
// Separate from ensureUniverseLoaded so the equity grid paints fast — MFs
// are ~5.7 MB raw / ~600 KB brotli and only matter when the user clicks the
// Mutual Funds tab. stocks.js calls this on tab activation.
export function ensureMfUniverseLoaded() {
  if (_mfLoadPromise) return _mfLoadPromise;
  _mfLoadPromise = (async () => {
    try {
      const res = await fetch("./js/data/mfFull.json", { cache: "default" });
      if (!res.ok) return false;
      const rows = await res.json();
      if (!Array.isArray(rows)) return false;
      const byS = {};
      for (const r of rows) {
        if (!r || !r.symbol) continue;
        byS[r.symbol] = {
          // Card / detail components share the EQUITY shape; map AMFI fields
          // onto the same property names (sector → category_bucket so the
          // sector pill row doesn't drown in 47 distinct categories) so
          // filterPipelines / getCloses don't need MF-specific branches.
          kind: "MF",
          price: null,
          marketCap: null,
          pe: null,
          pb: null,
          divYield: null,
          beta: null,
          logo: r.amc ? r.amc.split(/\s+/).slice(0, 2).map(w => w[0]).join("").slice(0, 3).toUpperCase() : "MF",
          sector: r.category_bucket || "Other",   // Equity / Debt / Hybrid / Index / etc.
          ...r,
        };
      }
      _mfBySymbol = byS;
      _mergedBySymbol = null;       // invalidate so getAllInstruments rebuilds
      _categoriesCache = null;
      try {
        window.dispatchEvent(new CustomEvent("ss:mf-universe-loaded", { detail: { count: rows.length } }));
      } catch (_) {}
      return true;
    } catch (_) {
      return false;
    }
  })();
  return _mfLoadPromise;
}

// ── Full merged view (Tier-2 + AMFI MFs + legacy MF placeholders) ──────────
export function getAllInstruments() {
  if (!_fullBySymbol && !_mfBySymbol) return INSTRUMENTS;
  if (_mergedBySymbol) return Object.values(_mergedBySymbol);
  const merged = {
    ...(_fullBySymbol || {}),
    ...(_mfBySymbol || {}),
    ..._placeholderMfsByS,         // legacy starter-portfolio codes
  };
  _mergedBySymbol = merged;
  return Object.values(merged);
}

// Full sector list — sorted, deduped, ETF rows excluded so the sector-pill
// row doesn't render a literal "ETF" button (ETFs get their own kind pill).
// MFs are also excluded — when the Mutual Funds tab is active stocks.js
// switches to category-bucket pills via getMfCategoryBuckets().
export function getAllSectors() {
  if (!_fullBySymbol) return SECTORS;
  if (_sectorsCache) return _sectorsCache;
  const set = new Set();
  for (const r of Object.values(_fullBySymbol)) {
    if (r.sector && r.kind !== "ETF" && r.kind !== "MF" && r.sector !== "Unknown") set.add(r.sector);
  }
  _sectorsCache = [...set].sort();
  return _sectorsCache;
}

// MF category buckets (Equity / Index / Hybrid / Debt / Solution / Commodity
// / FoF). Used by the Mutual Funds tab in stocks.js — replaces the sector
// pill row when filter.kind === "MF". Excludes "Other" since the bucketFor
// build step normalises everything into one of the named buckets now.
export function getMfCategoryBuckets() {
  if (!_mfBySymbol) return [];
  if (_categoriesCache) return _categoriesCache;
  const order = ["Equity", "Index", "Hybrid", "Debt", "Solution", "Commodity", "FoF"];
  const present = new Set();
  for (const r of Object.values(_mfBySymbol)) {
    if (r.category_bucket) present.add(r.category_bucket);
  }
  _categoriesCache = order.filter(b => present.has(b));
  return _categoriesCache;
}
