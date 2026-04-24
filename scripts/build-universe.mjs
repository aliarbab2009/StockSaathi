#!/usr/bin/env node
/**
 * build-universe.mjs — fetches the full NSE equity universe + Nifty index
 * constituents + NSE ETFs, merges, auto-classifies risk tier + cap bucket,
 * and writes app/js/data/universeFull.json (consumed lazily by universeLoader.js).
 *
 * Run locally:   node scripts/build-universe.mjs
 * Check mode:    node scripts/build-universe.mjs --check    (exits non-zero on sanity-gate fail)
 *
 * No external deps — uses Node 20+ built-in fetch. Manually maintains a
 * cookie jar because NSE and niftyindices.com 403 any fetch without a
 * browser-like session.
 *
 * IMPORTANT: This script runs on the developer's machine or in CI, NOT on
 * Vercel. The output JSON gets committed to the repo.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, "..");
const OUT_JSON = path.join(APP_ROOT, "js", "data", "universeFull.json");
const OUT_META = path.join(APP_ROOT, "js", "data", "universeFull.meta.json");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "DNT": "1",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

// ─── Cookie jar ──────────────────────────────────────────────────────────────
// Per-host map of cookie name → value. NSE and niftyindices use separate
// cookie sessions; do not cross-pollinate.
const _jars = new Map();        // host → { name: value }

function jarFor(host) {
  if (!_jars.has(host)) _jars.set(host, {});
  return _jars.get(host);
}
function updateCookies(host, res) {
  const raw = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") || "").split(/,(?=[^;]+=)/);
  const jar = jarFor(host);
  for (const line of raw) {
    if (!line) continue;
    const [kv] = line.split(";");
    const idx = kv.indexOf("=");
    if (idx > 0) {
      const k = kv.slice(0, idx).trim();
      const v = kv.slice(idx + 1).trim();
      if (k && v) jar[k] = v;
    }
  }
}
function cookieHeaderFor(host) {
  const jar = jarFor(host);
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function sessionFetch(url, { referer = null, extraHeaders = {} } = {}) {
  const u = new URL(url);
  const headers = {
    ...BROWSER_HEADERS,
    ...extraHeaders,
    Referer: referer || `https://${u.host}/`,
  };
  const cookie = cookieHeaderFor(u.host);
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, { headers, redirect: "follow" });
  updateCookies(u.host, res);
  return res;
}

async function warmHost(host) {
  try {
    const res = await sessionFetch(`https://${host}/`);
    if (!res.ok) console.warn(`[warm] ${host} returned ${res.status}`);
    return res.ok;
  } catch (e) {
    console.warn(`[warm] ${host}:`, e.message);
    return false;
  }
}

async function fetchText(url, { referer = null } = {}) {
  const res = await sessionFetch(url, { referer });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.text();
}

async function fetchJson(url, { referer = null } = {}) {
  const res = await sessionFetch(url, {
    referer,
    extraHeaders: { Accept: "application/json, text/plain, */*" },
  });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

// ─── CSV parser ─────────────────────────────────────────────────────────────
// Minimal CSV parser — NSE/NiftyIndices files are not pathologically quoted.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cols = splitCsvLine(line);
    const row = {};
    for (let i = 0; i < headers.length; i++) row[headers[i]] = cols[i] ?? "";
    return row;
  });
}
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { out.push(cur.trim()); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}

// ─── Sector taxonomy mapping ─────────────────────────────────────────────────
// NSE industry strings → StockSaathi's compact SECTORS vocab used by curated.js
// and the UI filter pills. Anything unmapped lands in "Other".
const NSE_TO_SS_SECTOR = {
  // Financials
  "Banks": "Banking",
  "Financial Services": "NBFC",
  "Insurance": "Insurance",
  "Financial Institutions": "NBFC",
  "Capital Markets": "NBFC",
  // Energy
  "Oil Gas & Consumable Fuels": "Energy",
  "Oil & Gas": "Energy",
  "Power": "Power",
  // IT / Telecom
  "Information Technology": "IT Services",
  "IT - Software": "IT Services",
  "Telecom - Services": "Telecom",
  "Telecommunication": "Telecom",
  // FMCG / Consumer
  "Fast Moving Consumer Goods": "FMCG",
  "Consumer Durables": "Consumer Elec",
  "Consumer Services": "Consumer",
  "Retailing": "Retail",
  "Realty": "Real Estate",
  // Materials
  "Metals & Mining": "Metals",
  "Cement & Cement Products": "Cement",
  "Chemicals": "Chemicals",
  "Construction Materials": "Cement",
  "Construction": "Construction",
  // Auto / Industrial
  "Automobile and Auto Components": "Auto",
  "Automobiles & Auto Components": "Auto",
  "Capital Goods": "Construction",
  // Healthcare
  "Healthcare": "Healthcare",
  "Pharmaceuticals": "Pharma",
  // Services / transport
  "Services": "Services",
  "Transport Services": "Services",
  "Transport Infrastructure": "Infrastructure",
  "Media Entertainment & Publication": "Services",
  // Food
  "Food Beverages & Tobacco": "FMCG",
  // Forest / paper
  "Forest Materials": "Other",
  "Paper Forest & Jute Products": "Other",
  "Textiles": "Other",
  "Diversified": "Conglomerate",
};

function mapSector(nseIndustry) {
  if (!nseIndustry) return "Other";
  const clean = nseIndustry.replace(/^"|"$/g, "").trim();
  return NSE_TO_SS_SECTOR[clean] || "Other";
}

// ─── Index bitmask ───────────────────────────────────────────────────────────
const IDX_NIFTY50       = 1 << 0;
const IDX_NIFTY100      = 1 << 1;
const IDX_NIFTY500      = 1 << 2;
const IDX_NIFTYMID150   = 1 << 3;
const IDX_NIFTYSMALL250 = 1 << 4;

function classifyRisk(row) {
  const { idx, series } = row;
  if (idx & IDX_NIFTY50)  return "low";
  if (idx & IDX_NIFTY100) return "low";
  if (idx & IDX_NIFTY500) return "med";
  if (idx & IDX_NIFTYMID150) return "med";
  if (series === "BE" || series === "BZ") return "high";
  return "high";
}

function classifyCapBucket(idx) {
  if (idx & IDX_NIFTY50) return "mega";
  if (idx & IDX_NIFTY100) return "large";
  if (idx & IDX_NIFTY500) return "mid";
  if (idx & IDX_NIFTYMID150) return "mid";
  if (idx & IDX_NIFTYSMALL250) return "small";
  return "micro";
}

// ─── Data fetchers ───────────────────────────────────────────────────────────
async function fetchNseEquityMaster() {
  console.log("[nse] fetching EQUITY_L.csv…");
  await warmHost("www.nseindia.com");
  const text = await fetchText(
    "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
    { referer: "https://www.nseindia.com/market-data/securities-available-for-trading" },
  );
  const rows = parseCsv(text);
  console.log(`[nse] parsed ${rows.length} equity rows`);
  return rows;
}

async function fetchNiftyConstituents(file) {
  const url = `https://niftyindices.com/IndexConstituent/${file}`;
  const text = await fetchText(url, { referer: "https://niftyindices.com/indices/equity" });
  const rows = parseCsv(text);
  // Normalize symbol + ISIN column names (NSE uses "ISIN Code", sometimes
  // "ISIN code" or "ISIN"). Return a Set of symbols for fast lookup.
  const syms = new Set();
  const isins = new Set();
  for (const r of rows) {
    const sym = (r.Symbol || r.symbol || r.SYMBOL || "").trim();
    const isin = (r["ISIN Code"] || r["ISIN code"] || r.ISIN || r.isin || "").trim();
    if (sym) syms.add(sym);
    if (isin) isins.add(isin);
  }
  console.log(`[nifty] ${file}: ${syms.size} symbols`);
  return { syms, isins, rows };
}

async function fetchNseEtfList() {
  console.log("[nse] fetching ETF list…");
  await warmHost("www.nseindia.com");
  try {
    // NSE's public-facing ETF API. Payload shape is { data: [{symbol, assets, ... }] }.
    const json = await fetchJson("https://www.nseindia.com/api/etf", {
      referer: "https://www.nseindia.com/market-data/exchange-traded-funds-etf",
    });
    const arr = json?.data || [];
    console.log(`[nse] ${arr.length} ETFs`);
    return arr;
  } catch (e) {
    console.warn("[nse] ETF fetch failed, continuing without ETFs:", e.message);
    return [];
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const checkMode = process.argv.includes("--check");
  const startTs = Date.now();

  // 1. Fetch NSE equity master
  let equities;
  try {
    equities = await fetchNseEquityMaster();
  } catch (e) {
    console.error("[fatal] NSE EQUITY_L.csv fetch failed:", e.message);
    console.error("[fatal] Without this, there's nothing to build. Check network / IP block.");
    process.exit(2);
  }

  // 2. Fetch Nifty index constituents (for idx bitmask + cap bucket)
  await warmHost("niftyindices.com");
  await warmHost("www.niftyindices.com");
  const [nifty50, nifty100, nifty500, niftyMid150, niftySmall250] = await Promise.all([
    fetchNiftyConstituents("ind_nifty50list.csv").catch(e => { console.warn("nifty50:", e.message); return { syms: new Set(), isins: new Set() }; }),
    fetchNiftyConstituents("ind_nifty100list.csv").catch(e => { console.warn("nifty100:", e.message); return { syms: new Set(), isins: new Set() }; }),
    fetchNiftyConstituents("ind_nifty500list.csv").catch(e => { console.warn("nifty500:", e.message); return { syms: new Set(), isins: new Set() }; }),
    fetchNiftyConstituents("ind_niftymidcap150list.csv").catch(e => { console.warn("niftymid150:", e.message); return { syms: new Set(), isins: new Set() }; }),
    fetchNiftyConstituents("ind_niftysmallcap250list.csv").catch(e => { console.warn("niftysmall250:", e.message); return { syms: new Set(), isins: new Set() }; }),
  ]);

  // 3. Fetch industry mapping from Nifty Total Market (has `Industry` column)
  let industryBySym = {};
  try {
    const tm = await fetchNiftyConstituents("ind_niftytotalmarket_list.csv");
    for (const r of tm.rows) {
      const sym = (r.Symbol || "").trim();
      const ind = (r.Industry || r["Macro-Economic Sector"] || "").trim();
      if (sym && ind) industryBySym[sym] = ind;
    }
    console.log(`[nifty] industry map covers ${Object.keys(industryBySym).length} symbols`);
  } catch (e) {
    console.warn("[nifty] total market list failed:", e.message);
  }

  // 4. Fetch ETFs
  const etfs = await fetchNseEtfList();

  // 5. Merge
  const out = [];
  const seenSym = new Set();

  // Normalize equities. NSE EQUITY_L columns:
  // SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE
  let dropped = 0;
  for (const r of equities) {
    const symbol = (r.SYMBOL || "").trim();
    const series = (r.SERIES || "").trim();
    // Main-board only for v1 — EQ/BE/BZ. SME (series SM/ST) excluded per plan.
    if (!symbol || !["EQ", "BE", "BZ"].includes(series)) { dropped++; continue; }
    if (seenSym.has(symbol)) { dropped++; continue; }

    const name = (r["NAME OF COMPANY"] || r["NAME OF COMPANY "] || "").trim().replace(/^"|"$/g, "");
    const isin = (r["ISIN NUMBER"] || r[" ISIN NUMBER"] || "").trim();
    const lotStr = (r["MARKET LOT"] || r[" MARKET LOT"] || "1").trim();
    const lot = parseInt(lotStr, 10) || 1;

    let idx = 0;
    if (nifty50.syms.has(symbol)) idx |= IDX_NIFTY50;
    if (nifty100.syms.has(symbol)) idx |= IDX_NIFTY100;
    if (nifty500.syms.has(symbol)) idx |= IDX_NIFTY500;
    if (niftyMid150.syms.has(symbol)) idx |= IDX_NIFTYMID150;
    if (niftySmall250.syms.has(symbol)) idx |= IDX_NIFTYSMALL250;

    const nseIndustry = industryBySym[symbol] || "";
    const sector = mapSector(nseIndustry);
    const capBucket = classifyCapBucket(idx);
    const risk = classifyRisk({ idx, series });

    out.push({
      symbol,
      name,
      sector,
      series,
      isin,
      idx,
      capBucket,
      risk,
      lot,
      kind: "EQUITY",
    });
    seenSym.add(symbol);
  }

  // ETFs — append with kind: "ETF". Schema simpler.
  for (const e of etfs) {
    const symbol = (e.symbol || "").trim();
    if (!symbol || seenSym.has(symbol)) continue;
    out.push({
      symbol,
      name: (e.meta?.companyName || e.assets || symbol).trim(),
      sector: "ETF",
      series: "EQ",
      isin: (e.meta?.isin || e.isin || "").trim(),
      idx: 0,
      capBucket: "unknown",
      risk: "med",
      lot: 1,
      kind: "ETF",
    });
    seenSym.add(symbol);
  }

  console.log(`[build] ${out.length} rows (${out.filter(r => r.kind === "EQUITY").length} equity, ${out.filter(r => r.kind === "ETF").length} ETF); dropped ${dropped}`);

  // 6. Sanity gates
  if (checkMode) {
    const eqCount = out.filter(r => r.kind === "EQUITY").length;
    if (eqCount < 1800) {
      console.error(`[check] FAIL: only ${eqCount} equities (expected ≥1800)`);
      process.exit(3);
    }
    // Every row must have non-empty symbol + sector + risk + capBucket + kind.
    for (const r of out) {
      if (!r.symbol || !r.sector || !r.risk || !r.capBucket || !r.kind) {
        console.error(`[check] FAIL: malformed row ${JSON.stringify(r)}`);
        process.exit(4);
      }
    }
    console.log("[check] OK");
  }

  // 6b. Compare vs existing artifact — warn on >10% row-count drop
  try {
    const existing = JSON.parse(await fs.readFile(OUT_JSON, "utf8"));
    const delta = out.length - existing.length;
    const pct = existing.length ? (delta / existing.length) * 100 : 0;
    if (existing.length > 100 && delta / existing.length < -0.1) {
      console.error(`[check] FAIL: row count dropped ${Math.abs(pct).toFixed(1)}% (${existing.length} → ${out.length})`);
      console.error("[check] Aborting write. Pass --force to override.");
      if (!process.argv.includes("--force")) process.exit(5);
    } else if (Math.abs(pct) > 2) {
      console.log(`[build] row count ${delta > 0 ? "+" : ""}${delta} (${pct.toFixed(1)}%)`);
    }
  } catch (_) {
    // No existing artifact yet — fine, first build.
  }

  // 7. Write
  const meta = {
    builtAt: new Date().toISOString(),
    rowCount: out.length,
    equityCount: out.filter(r => r.kind === "EQUITY").length,
    etfCount: out.filter(r => r.kind === "ETF").length,
    nifty50: nifty50.syms.size,
    nifty100: nifty100.syms.size,
    nifty500: nifty500.syms.size,
    niftyMid150: niftyMid150.syms.size,
    niftySmall250: niftySmall250.syms.size,
    industryCoverage: Object.keys(industryBySym).length,
    buildDurationMs: Date.now() - startTs,
  };
  await fs.writeFile(OUT_JSON, JSON.stringify(out));
  await fs.writeFile(OUT_META, JSON.stringify(meta, null, 2));
  console.log(`[build] wrote ${OUT_JSON} (${(JSON.stringify(out).length / 1024).toFixed(1)} KB)`);
  console.log(`[build] wrote ${OUT_META}`);
}

main().catch(e => {
  console.error("[fatal]", e);
  process.exit(1);
});
