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
let _mergedBySymbol = null;        // lazy: full ∪ MF placeholders
let _sectorsCache = null;          // lazy: union of sectors
let _loadPromise = null;           // de-dupes concurrent ensureUniverseLoaded calls

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
  // 1) Tier 2 (lazy-loaded full universe — has real sector / industry / cap)
  if (_fullBySymbol && _fullBySymbol[symbol]) return _fullBySymbol[symbol];
  // 2) MF placeholder (kept until Landing G's AMFI import lands)
  if (_placeholderMfsByS[symbol]) return _placeholderMfsByS[symbol];
  // 3) Stub — pages render stub-tolerant skeletons + kick Tier-3 enrichment
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

// ── Full merged view (Tier-2 + MF placeholders, sector-aware filtering) ────
export function getAllInstruments() {
  if (!_fullBySymbol) return INSTRUMENTS;
  if (_mergedBySymbol) return Object.values(_mergedBySymbol);
  const merged = { ..._fullBySymbol, ..._placeholderMfsByS };
  _mergedBySymbol = merged;
  return Object.values(merged);
}

// Full sector list — sorted, deduped, ETF rows excluded so the sector-pill
// row doesn't render a literal "ETF" button (ETFs get their own kind pill).
export function getAllSectors() {
  if (!_fullBySymbol) return SECTORS;
  if (_sectorsCache) return _sectorsCache;
  const set = new Set();
  for (const r of Object.values(_fullBySymbol)) {
    if (r.sector && r.kind !== "ETF" && r.sector !== "Unknown") set.add(r.sector);
  }
  _sectorsCache = [...set].sort();
  return _sectorsCache;
}
