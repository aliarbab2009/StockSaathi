// =============================================================================
// UNIVERSE LOADER — merges curated (Tier 1, boot-critical) + universeFull.json
// (Tier 2, ~2,200 NSE equities, lazy-loaded). Returns stub for unknown symbols
// so callers never crash on undefined.
//
// Sync API (getInstrument/STOCKS/INSTRUMENTS/SECTORS/INSTRUMENT_BY_SYMBOL) stays
// valid from module-load onwards — curated is enough for correctness. The full
// universe hydrates in the background and augments the map + fires ss:universe-
// loaded so pages can re-render.
// =============================================================================

import { STOCKS as CURATED_STOCKS, MUTUAL_FUNDS, ONBOARDING_PORTFOLIOS } from "./curated.js";

// -- Tier 1 view (backward compat) --------------------------------------------
// These exports match the old universe.js shape exactly; no caller edit needed.
export { ONBOARDING_PORTFOLIOS };

export const STOCKS = CURATED_STOCKS;

const CURATED_INSTRUMENTS = [
  ...STOCKS.map(s => ({ ...s, kind: "EQUITY" })),
  ...MUTUAL_FUNDS.map(m => ({ ...m, kind: "MF", price: m.nav })),
];

export const INSTRUMENTS = CURATED_INSTRUMENTS;

export { MUTUAL_FUNDS };

const CURATED_BY_SYMBOL = Object.fromEntries(
  CURATED_INSTRUMENTS.map(i => [i.symbol, i])
);

// Module-scoped mutable maps. Start with curated; universeFull merges in on load.
let _fullBySymbol = null;          // populated after ensureUniverseLoaded resolves
let _mergedBySymbol = null;        // lazy: curated ∪ full
let _sectorsCache = null;          // lazy: union of sectors
let _loadPromise = null;           // de-dupes concurrent ensureUniverseLoaded calls

export const INSTRUMENT_BY_SYMBOL = CURATED_BY_SYMBOL;   // unchanged snapshot — Phase 3 swaps this
export const SECTORS = [...new Set(STOCKS.map(s => s.sector))].sort();

// Returns a live instrument object, or a stub for unknown symbols. NEVER
// returns undefined — callers that read .risk / .name / .sector / .kind are
// free to access them without null-guards as long as they accept "Unknown"
// sector and "med" risk.
export function getInstrument(symbol) {
  if (!symbol) return null;
  // 1) Curated — hand-tagged, always present
  const c = CURATED_BY_SYMBOL[symbol];
  if (c) return c;
  // 2) Tier 2 (lazy-loaded)
  if (_fullBySymbol) {
    const f = _fullBySymbol[symbol];
    if (f) return f;
  }
  // 3) Stub — lets pages mount and kick Tier-3 enrichment
  return {
    symbol,
    name: symbol,
    sector: "Unknown",
    kind: "EQUITY",
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

// Loads universeFull.json once and populates the Tier-2 map. Idempotent.
// Safe to call before/without the JSON existing — falls back silently to
// curated-only behavior and returns false.
export function ensureUniverseLoaded() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const res = await fetch("./js/data/universeFull.json", { cache: "default" });
      if (!res.ok) return false;
      const rows = await res.json();
      if (!Array.isArray(rows)) return false;
      // Normalize each row to full instrument shape. kind defaults to EQUITY.
      const byS = {};
      for (const r of rows) {
        if (!r || !r.symbol) continue;
        byS[r.symbol] = {
          kind: r.kind || "EQUITY",
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
      // Re-broadcast so pages can re-render
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

// Full merged view — lazy-built on first access after universeFull loads.
// Returns curated-only if Tier 2 never loaded.
export function getAllInstruments() {
  if (!_fullBySymbol) return CURATED_INSTRUMENTS;
  if (_mergedBySymbol) return Object.values(_mergedBySymbol);
  const merged = { ..._fullBySymbol, ...CURATED_BY_SYMBOL };   // curated wins
  _mergedBySymbol = merged;
  return Object.values(merged);
}

// Full sector list — union of curated + Tier-2 sectors. Sorted, deduped.
export function getAllSectors() {
  if (!_fullBySymbol) return SECTORS;
  if (_sectorsCache) return _sectorsCache;
  const set = new Set(SECTORS);
  for (const r of Object.values(_fullBySymbol)) {
    if (r.sector) set.add(r.sector);
  }
  _sectorsCache = [...set].sort();
  return _sectorsCache;
}
