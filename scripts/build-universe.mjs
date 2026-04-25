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
// NSE Indices uses a 4-tier classification: 12 Macro / 22 Sector / 59 Industry
// / 197 Basic Industry. The Nifty Total Market CSV's "Industry" column is
// actually the SECTOR tier (22 values) — every bank, NBFC, AMC, insurer,
// exchange, and fintech ships as "Financial Services". We disambiguate via
// symbol/name pattern below.
//
// See: https://www.niftyindices.com/docs/default-source/default-document-library/nse-indices_industry-classification-guideline-2023-07.pdf
//
// Output sectors must stay in the 27-value SECTORS vocab consumed by curated.js
// and the UI filter pills (Auto, Aviation, Banking, Cement, Chemicals,
// Conglomerate, Construction, Consumer, Consumer Elec, Energy, Exchange,
// Fintech, FMCG, Food, Healthcare, Infrastructure, Insurance, Internet,
// IT Services, Metals, NBFC, Pharma, Power, Real Estate, Retail, Services,
// Telecom). Anything unresolved lands in "Other".
const NSE_TO_SS_SECTOR = {
  // Financials — coarse default; refineFinancialServices() splits by name.
  "Financial Services": "NBFC",
  "Banks": "Banking",
  "Insurance": "Insurance",
  "Financial Institutions": "NBFC",
  "Capital Markets": "NBFC",
  // Energy
  "Oil Gas & Consumable Fuels": "Energy",
  "Oil & Gas": "Energy",
  "Power": "Power",
  "Utilities": "Power",
  // IT / Telecom
  "Information Technology": "IT Services",
  "IT - Software": "IT Services",
  "Telecom - Services": "Telecom",
  "Telecommunication": "Telecom",
  // FMCG / Consumer — Consumer Durables defaults to Consumer Elec (most
  // appliances/electronics/lighting); jewellers/paints/furniture rerouted by
  // name pattern in refineConsumerDurables().
  "Fast Moving Consumer Goods": "FMCG",
  "Food Beverages & Tobacco": "FMCG",
  "Consumer Durables": "Consumer Elec",
  "Consumer Services": "Consumer",       // refineConsumerServices() splits.
  "Retailing": "Retail",
  "Realty": "Real Estate",
  // Materials
  "Metals & Mining": "Metals",
  "Cement & Cement Products": "Cement",
  "Construction Materials": "Cement",
  "Chemicals": "Chemicals",
  "Construction": "Construction",
  "Capital Goods": "Infrastructure",     // turbines, machinery, defence kit.
  // Auto / Industrial
  "Automobile and Auto Components": "Auto",
  "Automobiles & Auto Components": "Auto",
  // Healthcare — Healthcare (sector) covers hospitals + pharma at this tier;
  // refineHealthcare() routes drug-makers to Pharma by name pattern.
  "Healthcare": "Healthcare",
  "Pharmaceuticals": "Pharma",
  // Services / transport / media — Services bucket holds aviation, ports,
  // logistics; refineServices() pulls airlines into Aviation, ports into
  // Infrastructure.
  "Services": "Services",
  "Transport Services": "Services",
  "Transport Infrastructure": "Infrastructure",
  "Media Entertainment & Publication": "Services",
  // Misc
  "Forest Materials": "Other",
  "Paper Forest & Jute Products": "Other",
  "Textiles": "Other",
  "Diversified": "Conglomerate",
};

// Symbol-level overrides — for the handful of names whose NSE sector clearly
// misrepresents how curated.js / users think of them. Keep this list short.
const SYMBOL_OVERRIDES = {
  ADANIENT:  "Conglomerate",  // NSE: Metals & Mining (because of Adani Coal).
  GRASIM:    "Conglomerate",  // NSE: Cement.
  RELIANCE:  "Energy",        // Already Energy from Oil&Gas, but pin it.
  IRCTC:     "Services",      // NSE: Consumer Services — but it's railway/travel.
  ADANIPORTS:"Infrastructure",// NSE: Services.
  GMRAIRPORT:"Infrastructure",
  INDIGO:    "Aviation",
  SPICEJET:  "Aviation",
};

// ─── Refinement helpers — disambiguate macro buckets by name pattern. ────────
// These run AFTER the table lookup. Order matters: more-specific routes win.

function refineFinancialServices(symbol, name) {
  const n = (name || "").toLowerCase();
  const s = (symbol || "").toUpperCase();
  // Banks: explicit in name OR symbol ends in BK / BANK / B (PNB, SBIN, etc.)
  if (/\bbank\b|\bbanking\b/.test(n)) return "Banking";
  if (/(BANK|BK)$/.test(s) || s === "SBIN" || s === "PNB") return "Banking";
  // Life / general insurance
  if (/\binsurance\b|life ins|gic\b|general insurance|reinsurance/.test(n)) return "Insurance";
  // Stock / commodity exchanges + depositories
  if (/exchange|depositor|bourse|cdsl|nsdl|mcx|bse\b/.test(n)) return "Exchange";
  // Fintech: payments / digital lending / online financial-marketplaces.
  if (/paytm|fintech|payment|policybazaar|pb fintech|one ?97|nykaa|paisabazaar|mobikwik|bharatpe/.test(n)) return "Fintech";
  // Default: NBFC bucket (asset managers, housing finance, brokers, holding cos).
  return "NBFC";
}

function refineConsumerServices(symbol, name) {
  const n = (name || "").toLowerCase();
  // E-commerce / internet platforms.
  if (/zomato|eternal|swiggy|nykaa|fsn e-?commerce|info ?edge|naukri|policybazaar|pb fintech|justdial|matrimon|cartrade|easemytrip|paytm/.test(n)) return "Internet";
  // Quick-service restaurants / food delivery operators.
  if (/jubilant ?food|domino|westlife|devyani|sapphire|barbeque|speciality restaurant|coffee day/.test(n)) return "Food";
  // Brick-and-mortar / multi-brand retail.
  if (/avenue ?supermart|dmart|trent|aditya birla fashion|shoppers stop|v2 retail|spencer|future retail|vishal mega/.test(n)) return "Retail";
  // Travel / hospitality / leisure.
  if (/aviation|airline|airways|indigo|spicejet/.test(n)) return "Aviation";
  if (/hotel|leisure|resort|indian hotels|lemon tree|chalet|eih\b/.test(n)) return "Services";
  return "Consumer";
}

function refineConsumerDurables(symbol, name) {
  const n = (name || "").toLowerCase();
  // Jewellery, paints, furniture, ceramics — feel like "Consumer" to teens,
  // not "Consumer Elec".
  if (/titan|kalyan|senco|tribhovandas|jewell|gold/.test(n)) return "Consumer";
  if (/paint|asian paints|berger|akzo|kansai|nerolac|indigo paint/.test(n)) return "Consumer";
  if (/furniture|ceramic|kajaria|cera\b|somany|hindware/.test(n)) return "Consumer";
  return "Consumer Elec";
}

function refineHealthcare(symbol, name) {
  const n = (name || "").toLowerCase();
  // Hospitals + diagnostics stay as Healthcare.
  if (/hospital|healthcare|medic|clinic|diagnost|metropolis|dr ?lal|fortis|apollo|max health|narayana|aster|krishna institute/.test(n)) return "Healthcare";
  // Everything else under the NSE "Healthcare" sector is a drug-maker.
  return "Pharma";
}

function refineServices(symbol, name) {
  const n = (name || "").toLowerCase();
  if (/airline|aviation|airways|indigo|spicejet/.test(n)) return "Aviation";
  if (/port\b|ports\b|airport|logistic|shipping|container|allcargo|gateway distri/.test(n)) return "Infrastructure";
  return "Services";
}

// ─── Name-pattern fallback — runs when the symbol isn't in the Total Market
// CSV (Nifty Total Market only covers ~750 of the 2,364 main-board equities,
// so without this everything else lands in "Other"). Keyword-driven; broad
// nets first, narrow refinements last.
function inferFromName(symbol, name) {
  const n = (name || "").toLowerCase();
  const s = (symbol || "").toUpperCase();
  if (!n) return "Other";

  // Banks / NBFCs / financials.
  if (/\bbank\b|\bbanking\b/.test(n) || /(BANK|BK)$/.test(s)) return "Banking";
  if (/\binsurance\b|life ins|reinsurance/.test(n)) return "Insurance";
  if (/exchange|depositor|cdsl|nsdl/.test(n)) return "Exchange";
  if (/fintech|payment|paytm|policybazaar|one ?97/.test(n)) return "Fintech";
  if (/finance|financ|capital|investment|securities|broking|asset manag|housing finance|microfin|nbfc|holding/.test(n)) return "NBFC";

  // Tech / telecom / internet.
  if (/software|technolog|infotech|systems|infosys|tcs|wipro|consultanc|digital|cyber|cloud|datamatic|persistent|coforge|mphasis|kpit|tata elxsi|happiest mind|zensar|hexaware|birlasoft|cyient|sonata|sasken|nazara/.test(n)) return "IT Services";
  if (/telecom|airtel|vodafone|tata communic|tejas net|gtl/.test(n)) return "Telecom";
  if (/internet|e-?commerce|ecommerce|online|nykaa|zomato|eternal|info ?edge|naukri|justdial/.test(n)) return "Internet";

  // Pharma / healthcare.
  if (/hospital|healthcare|medical|clinic|diagnost|metropolis|dr ?lal/.test(n)) return "Healthcare";
  if (/pharma|drugs|labor|laborator|biotech|biocon|cipla|sun pharm|aurobindo|lupin|alkem|torrent pharm|glenmark|natco|divis|ipca|abbott|sanofi|pfizer|gland|zydus|granul|jb chem|ajanta pharma|caplin|hester|wockhardt|fdc|emcure/.test(n)) return "Pharma";

  // Energy / power / oil.
  if (/oil|gas|petrol|petroleum|refiner|natural gas|hpcl|bpcl|iocl|ongc|gail|reliance industri/.test(n)) return "Energy";
  if (/power|electric|energy|hydro|thermal|solar|wind|renewable|ntpc|tata power|adani green|adani power|jsw energy|nhpc|sjvn|torrent power/.test(n)) return "Power";

  // Auto / cement / metals / chem.
  if (/motor|auto|tyre|tyres|automobile|automotive|ashok leyland|tata moto|maruti|m&m|mahindra|hero moto|bajaj auto|tvs|escorts|exide|amara raja|bharat forge|motherson|sundaram|wabco|endurance|sona blw|bosch|minda|jbm/.test(n)) return "Auto";
  if (/cement|ultratech|ambuja|acc\b|shree cement|dalmia|jk cement|ramco|birla corp|heidelberg|sagar cement|orient cement|prism|nuvoco/.test(n)) return "Cement";
  if (/steel|metal|mining|iron|aluminium|aluminum|copper|zinc|lead|coal|hindalco|jindal|sail|nmdc|moil|vedanta|tata steel|jsw steel|jspl|ratnamani|welspun|maharashtra seamless/.test(n)) return "Metals";
  if (/chemic|paints|fertilis|fertiliz|pesticid|agrochem|specialty chem|pidilite|deepak|aarti|navin fluorine|gujarat fluorochem|atul|alkyl|laxmi organic|tata chem|coromandel|rallis|upl\b|sumitomo chemic|bayer crop|insecticides/.test(n)) return "Chemicals";

  // Real estate / construction / infra.
  if (/realty|propert|develop|estate|infrastructur|builder|construction|housing|dlf|godrej propert|prestige|brigade|sobha|oberoi realty|lodha|macrotech|sunteck|kolte ?patil/.test(n)) {
    if (/realty|properties|estate|developer|housing|sobha|prestige|brigade|oberoi realty|lodha|macrotech|kolte/.test(n)) return "Real Estate";
    if (/infrastructur|gmr|adani port|irb|ircon|rites|hg infra|ashoka build|dilip buildcon|kec international|kalpataru/.test(n)) return "Infrastructure";
    return "Construction";
  }

  // FMCG / consumer / retail / food.
  if (/fmcg|hindustan unilever|nestl|britannia|marico|dabur|godrej consum|colgate|tata consum|emami|jyothy|gillette|p&g|procter|patanjali|bikaji|gopal snack/.test(n)) return "FMCG";
  if (/restaurant|food ?work|jubilant food|domino|westlife|devyani|sapphire|barbeque|kfc|pizza/.test(n)) return "Food";
  if (/retail|supermart|dmart|trent|shoppers stop|aditya birla fashion|v2 retail|vmart/.test(n)) return "Retail";

  // Aviation / hotels / media.
  if (/airline|aviation|airways|indigo|spicejet/.test(n)) return "Aviation";
  if (/hotel|resort|leisure|indian hotels|lemon tree|chalet|eih\b/.test(n)) return "Services";
  if (/media|broadcast|entertainment|television|news|publication|saregama|zee\b|sun tv|pvr|inox/.test(n)) return "Services";

  // Diversified holding companies.
  if (/diversified|enterprises|holdings|conglomerate/.test(n)) return "Conglomerate";

  return "Other";
}

function mapSector(nseIndustry, symbol = "", name = "") {
  // 1. Symbol override wins — for hand-curated misclassifications.
  if (symbol && SYMBOL_OVERRIDES[symbol]) return SYMBOL_OVERRIDES[symbol];

  // 2. Table lookup on the NSE sector value.
  const clean = (nseIndustry || "").replace(/^"|"$/g, "").trim();

  if (clean) {
    const base = NSE_TO_SS_SECTOR[clean];
    if (!base) return "Other";
    // 3. Refine ambiguous macro buckets via name pattern.
    if (clean === "Financial Services") return refineFinancialServices(symbol, name);
    if (clean === "Consumer Services")  return refineConsumerServices(symbol, name);
    if (clean === "Consumer Durables")  return refineConsumerDurables(symbol, name);
    if (clean === "Healthcare")          return refineHealthcare(symbol, name);
    if (clean === "Services")            return refineServices(symbol, name);
    return base;
  }

  // 4. Symbol not in Nifty Total Market (covers only ~750/2364 equities) —
  //    fall back to name-keyword inference so the long tail doesn't all
  //    land in "Other".
  return inferFromName(symbol, name);
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
    const sector = mapSector(nseIndustry, symbol, name);
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
