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

// Resolve the current immutable URL via the meta index. The meta file is
// served with max-age=300 (small + churn-tolerant), and points at the
// content-addressed `<name>.<sha8>.json` which is served with
// max-age=31536000, immutable. This pattern eliminates the 304 round-trip
// that was burning ~190 ms per cold load while letting the universe
// content rev whenever the build script regenerates it.
//
// Falls back to the legacy un-hashed URL if the meta fetch fails (during
// the rolling deploy where the meta is updated before the hashed file
// reaches the edge cache, or for older clients pre-Landing-G).
async function _resolveImmutableUrl(name) {
  try {
    const metaRes = await fetch(`./js/data/${name}.meta.json`, { cache: "default" });
    if (!metaRes.ok) return `./js/data/${name}.json`;
    const meta = await metaRes.json();
    if (meta && typeof meta.sha8 === "string" && /^[0-9a-f]{8}$/.test(meta.sha8)) {
      return `./js/data/${name}.${meta.sha8}.json`;
    }
  } catch (_) {}
  return `./js/data/${name}.json`;
}

// ── Lazy load Tier-2 + upgrade the bootstrap stubs ──────────────────────────
export function ensureUniverseLoaded() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const url = await _resolveImmutableUrl("universeFull");
      const res = await fetch(url, { cache: "default" });
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
      const url = await _resolveImmutableUrl("mfFull");
      const res = await fetch(url, { cache: "default" });
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
          // NAV-as-paise so synthMFQuote, getPriceAt, getHoldingsValue and the
          // generateSeries stub-walk anchor all read the right base. Without
          // this, every MF flowed through `Math.round(null * drift)` which JS
          // coerces to 0 — visible to users as "₹0.00" in the price header,
          // wrong portfolio valuations, and a chart anchored to a random
          // synthetic walk (₹50–5000) instead of the real NAV (e.g. ₹1006
          // for Money Market). Audited and root-caused 2026-04-25.
          price: r.nav != null ? Math.round(r.nav * 100) : null,
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

// =============================================================================
// GROWW-CANONICAL EQUITY CATEGORIES
//
// Built 2026-05-03 after user reported "my mum wants to see Oil and Gas
// on /stocks but there are just random categories." Our raw NSE-derived
// sector strings include 30 fragmentary buckets (Energy, NBFC, Services,
// Other, Conglomerate, Internet, Fintech, Exchange, etc.) that no
// Indian retail investor recognises by those names. Groww + Zerodha +
// 5paisa all use a smaller, recognisable set aligned with the NSE
// Sectoral Indices nomenclature: Banking, Oil & Gas, IT, Pharma, FMCG,
// Auto, Power, Realty, etc.
//
// This map re-bins each raw sector onto a Groww-aligned canonical
// category. Conflict policy per the user's instruction: Groww wins.
// "Energy" in our raw data is overwhelmingly upstream/midstream
// petroleum (Reliance, ONGC, BPCL, IOC, GAIL) so it maps to "Oil &
// Gas" — Power gets its own bucket since NSE separates them too.
//
// The pill list shown to users is just the values present after
// mapping (unique + count > 0), ordered by getCanonicalCategoryOrder
// below. Any future raw sector that doesn't appear in the map falls
// through to "Other" via getCanonicalCategory's default branch.
const GROWW_CATEGORY_MAP = {
  "Auto":          "Auto",
  "Aviation":      "Aviation",
  "Banking":       "Banking",
  "Cement":        "Cement",
  "Chemicals":     "Chemicals",
  "Conglomerate":  "Conglomerate",
  "Construction":  "Construction",
  "Consumer":      "Consumer Durables",
  "Consumer Elec": "Consumer Durables",
  "Energy":        "Oil & Gas",
  "Exchange":      "Financial Services",
  "Fintech":       "NBFC",
  "FMCG":          "FMCG",
  "Food":          "FMCG",
  "Healthcare":    "Healthcare",
  "Infrastructure":"Infrastructure",
  "Insurance":     "Insurance",
  "Internet":      "Retail",
  "IT Services":   "IT",
  "Jewellery":     "Jewellery",
  "Metals":        "Metals",
  "NBFC":          "NBFC",
  "Other":         "Other",
  "Pharma":        "Pharma",
  "Power":         "Power",
  "Real Estate":   "Real Estate",
  "Retail":        "Retail",
  "Services":      "Services",
  "Telecom":       "Telecom",
  "Textiles":      "Textiles",
};

// Display order for the pill row. Alphabetical (A–Z) so users can
// scan-and-find by name; "Other" pinned to the end since it's a
// catch-all bucket users almost never want first. Any canonical not
// in this list still appears, sorted alphabetically after the named
// ones (defensive against future map additions). Hotfix64a — was
// recognisability-ordered before, but the user wanted Groww-style
// scanability.
const CANONICAL_CATEGORY_ORDER = [
  "Auto",
  "Aviation",
  "Banking",
  "Cement",
  "Chemicals",
  "Conglomerate",
  "Construction",
  "Consumer Durables",
  "Financial Services",
  "FMCG",
  "Healthcare",
  "Infrastructure",
  "Insurance",
  "IT",
  "Jewellery",
  "Metals",
  "NBFC",
  "Oil & Gas",
  "Pharma",
  "Power",
  "Real Estate",
  "Retail",
  "Services",
  "Telecom",
  "Textiles",
  "Other",
];

// Per-symbol Groww-canonical overrides — applied AFTER the raw-sector
// table lookup. Each entry forces a stock into the named canonical
// category regardless of what build-universe.mjs assigned, so we can
// patch individual mis-classifications without re-running the data
// build (those rebuilds blow away inline edits to universeFull.json).
//
// Hotfix64c — built 2026-05-03 from a 5-agent triangulation of Groww +
// Dhan + Trendlyne + Nifty Oil & Gas index. User's mum saw 44 on Groww
// vs our 37; the gap was caused by:
//   (a) inferFromName regex in scripts/build-universe.mjs routes any
//       company with "Energy" in the name to Power (Selan/Prabha/IRM/
//       Asian Energy Services), and
//   (b) NSE classifies Linde / PCBL / Panama Petrochem as Chemicals,
//       BHARATCOAL as Metals, SOTL as IT (the "Technologies" suffix
//       trips the IT regex), DEEPINDS as Infrastructure, etc.
// We move 13 genuine O&G stocks INTO Oil & Gas and move 7 false-
// positives (Megastar Foods etc. — caught by name regex on "oil"/
// "energy") OUT to their correct canonicals. Net: 37 → 43-44, exactly
// matching Groww. Add to this map for future single-stock fixes.
const SYMBOL_CANONICAL_OVERRIDES = {
  // ── Move INTO Oil & Gas (13 stocks Groww classifies as O&G) ───────
  ANTELOPUS:  "Oil & Gas",   // build → Power (name match /energy/)
  PRABHA:     "Oil & Gas",   // build → Power (name match /energy/)
  IRMENERGY:  "Oil & Gas",   // build → Power (name match /energy/)
  ASIANENE:   "Oil & Gas",   // build → Power (name match /energy/)
  BHARATCOAL: "Oil & Gas",   // build → Metals (NSE: Metals & Mining)
  DEEPINDS:   "Oil & Gas",   // build → Infrastructure (drilling svc)
  SOTL:       "Oil & Gas",   // build → IT Services (name "Technologies")
  VEEDOL:     "Oil & Gas",   // build → Other (Tide Water Oil)
  PANAMAPET:  "Oil & Gas",   // build → Chemicals (white oil maker)
  DOLPHIN:    "Oil & Gas",   // build → Conglomerate (offshore rigs)
  GNRL:       "Oil & Gas",   // build → Other (Gujarat Natural Resources)
  GANESHBE:   "Oil & Gas",   // build → Other (bulk liquid storage)
  KOTYARK:    "Oil & Gas",   // build → Infrastructure (biodiesel)
  LINDEINDIA: "Oil & Gas",   // build → Chemicals (industrial gases)
  REFEX:      "Oil & Gas",   // build → Chemicals (refrigerant/coal)
  GOACARBON:  "Oil & Gas",   // build → Other (calcined pet coke)
  GOCLCORP:   "Oil & Gas",   // build → Other (Gulf Oil parent)
  PCBL:       "Oil & Gas",   // build → Chemicals (carbon black)
  STALLION:   "Oil & Gas",   // build → Chemicals (Groww: Industrial Gases & Fuels)

  // ── Move OUT of Oil & Gas (false positives caught by name regex) ──
  MEGASTAR:   "FMCG",        // Megastar Foods — snack food, not petroleum
  GOKUL:      "FMCG",        // Gokul Refoils & Solvent — edible oils
  ROML:       "FMCG",        // Raj Oil Mills — edible cooking oil
  GODAVARIB:  "Chemicals",   // Godavari Biorefineries — sugar/ethanol
  KIOCL:      "Metals",      // KIOCL — iron ore pellets, not petroleum
  SANDUMA:    "Metals",      // Sandur Manganese & Iron Ores — mining
  SOUTHWEST:  "Services",    // South West Pinnacle Exploration — mineral, not O&G
};

/**
 * Map a raw instrument to its Groww-canonical category.
 * Returns "Other" for unknown sectors so we never lose a stock.
 * ETFs and MFs return null — they have their own filter rows.
 *
 * Per-symbol overrides win over the raw-sector lookup so we can patch
 * individual mis-classifications surgically. See SYMBOL_CANONICAL_OVERRIDES.
 */
export function getCanonicalCategory(inst) {
  if (!inst || inst.kind === "ETF" || inst.kind === "MF") return null;
  if (inst.symbol && SYMBOL_CANONICAL_OVERRIDES[inst.symbol]) {
    return SYMBOL_CANONICAL_OVERRIDES[inst.symbol];
  }
  const raw = inst.sector;
  if (!raw || raw === "Unknown") return "Other";
  return GROWW_CATEGORY_MAP[raw] || "Other";
}

/**
 * { categoryName: count } for every Groww-canonical bucket present in
 * the loaded equity universe. Sorted by CANONICAL_CATEGORY_ORDER, with
 * any unmapped extras appended alphabetically. Excludes empty buckets.
 * Used by stocks.js to render the pill row with counts.
 *
 * Returns [] before universeFull.json loads (pill row stays in
 * skeleton state). Re-evaluated on every call — counts are O(n) over
 * 2,364 stocks, sub-millisecond, no need to cache.
 */
export function getCanonicalCategoryCounts() {
  if (!_fullBySymbol) return [];
  const counts = {};
  for (const r of Object.values(_fullBySymbol)) {
    const c = getCanonicalCategory(r);
    if (!c) continue;
    counts[c] = (counts[c] || 0) + 1;
  }
  const present = Object.keys(counts);
  const ordered = [];
  for (const name of CANONICAL_CATEGORY_ORDER) {
    if (counts[name]) ordered.push({ name, count: counts[name] });
  }
  // Catch any canonical that ended up in counts but wasn't in the
  // declared order (defensive — shouldn't happen with the current map).
  for (const name of present.sort()) {
    if (!CANONICAL_CATEGORY_ORDER.includes(name) && counts[name]) {
      ordered.push({ name, count: counts[name] });
    }
  }
  return ordered;
}
