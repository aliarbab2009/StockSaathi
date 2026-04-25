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
import crypto from "node:crypto";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const brotli = promisify(zlib.brotliCompress);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, "..");
const OUT_DIR  = path.join(APP_ROOT, "js", "data");
const OUT_JSON = path.join(OUT_DIR, "universeFull.json");
const OUT_META = path.join(OUT_DIR, "universeFull.meta.json");

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
  if (/finance|financ|capital|investment|securities|broking|asset manag|housing finance|microfin|nbfc|holding|world money|forex|currency exchange|money limited/.test(n)) return "NBFC";

  // Tech / telecom / internet.
  if (/software|technolog|infotech|systems|infosys|tcs|wipro|consultanc|digital|cyber|cloud|datamatic|persistent|coforge|mphasis|kpit|tata elxsi|happiest mind|zensar|hexaware|birlasoft|cyient|sonata|sasken|nazara|knowledgeware|alldigi|digitech|tech limited|tech ?services|solutions limited|it services|it consulting|business process|bpo|kpo|analytics|automation|saas\b|platform/.test(n)) return "IT Services";
  // Telecom — added "telephone" + "mahanagar" + "nigam" so MTNL
  // ("Mahanagar Telephone Nigam Limited") classifies correctly. Pre-fix
  // MTNL fell through to "Other" because the regex only had "telecom"
  // (the company's name uses "telephone").
  if (/telecom|telephone|airtel|vodafone|tata communic|tejas net|gtl|optifibre|fibre optic|fiber optic|optical fibre|bharti hexa|mahanagar.*telephone|telephone nigam/.test(n)) return "Telecom";
  if (/internet|e-?commerce|ecommerce|online|nykaa|zomato|eternal|info ?edge|naukri|justdial/.test(n)) return "Internet";

  // Pharma / healthcare.
  if (/hospital|healthcare|medical|clinic|diagnost|metropolis|dr ?lal/.test(n)) return "Healthcare";
  if (/pharma|drugs|labor|laborator|biotech|biocon|cipla|sun pharm|aurobindo|lupin|alkem|torrent pharm|glenmark|natco|divis|ipca|abbott|sanofi|pfizer|gland|zydus|granul|jb chem|ajanta pharma|caplin|hester|wockhardt|fdc|emcure|remed|nutraceutic|formulation|life sciences|biolog|veterinary|panacea|sparc|zenotech|piramal pharma|sequent scientific|suven|orchid|shilpa medicare|caplin point|lincoln pharma|kilitch|krebs|mangalam drugs|sms pharma|smruthi organics|venus remed/.test(n)) return "Pharma";

  // Energy / power / oil.
  if (/oil|gas|petrol|petroleum|refiner|natural gas|hpcl|bpcl|iocl|ongc|gail|reliance industri|exploration|drilling|seismic|alphageo|aakash exploration/.test(n)) return "Energy";
  if (/power|electric|energy|hydro|thermal|solar|wind|renewable|ntpc|tata power|adani green|adani power|jsw energy|nhpc|sjvn|torrent power/.test(n)) return "Power";

  // Auto / cement / metals / chem.
  if (/motor|auto|tyre|tyres|automobile|automotive|ashok leyland|tata moto|maruti|m&m|mahindra|hero moto|bajaj auto|tvs|escorts|exide|amara raja|bharat forge|motherson|sundaram|wabco|endurance|sona blw|bosch|minda|jbm/.test(n)) return "Auto";
  if (/cement|ultratech|ambuja|acc\b|shree cement|dalmia|jk cement|ramco|birla corp|heidelberg|sagar cement|orient cement|prism|nuvoco/.test(n)) return "Cement";
  if (/steel|metal|mining|iron|aluminium|aluminum|copper|zinc|lead|coal|hindalco|jindal|sail|nmdc|moil|vedanta|tata steel|jsw steel|jspl|ratnamani|welspun|maharashtra seamless/.test(n)) return "Metals";
  if (/chemic|paints|fertilis|fertiliz|pesticid|agrochem|specialty chem|pidilite|deepak|aarti|navin fluorine|gujarat fluorochem|atul|alkyl|laxmi organic|tata chem|coromandel|rallis|upl\b|sumitomo chemic|bayer crop|insecticides|agri-?tech|agri industries|plastic|polymer|packaging|greenpac|polyfilm|petrochem/.test(n)) return "Chemicals";

  // Real estate / construction / infra. Anything that mentions infra /
  // infrabuild / infra-projects / encon / ashoka / NCC builders is treated
  // as Construction by default, even when "Infrastructure" or specific
  // builder names don't appear in-line.
  if (/realty|propert|develop|estate|infrastructur|builder|construction|housing|dlf|godrej propert|prestige|brigade|sobha|oberoi realty|lodha|macrotech|sunteck|kolte ?patil|infra-?build|infra-?projects|encon|projects limited|engineering construction|civil engineering|piling/.test(n)) {
    if (/realty|properties|estate|developer|housing|sobha|prestige|brigade|oberoi realty|lodha|macrotech|kolte/.test(n)) return "Real Estate";
    if (/infrastructur|gmr|adani port|irb|ircon|rites|hg infra|ashoka build|dilip buildcon|kec international|kalpataru/.test(n)) return "Infrastructure";
    return "Construction";
  }

  // FMCG / consumer / retail / food.
  if (/fmcg|hindustan unilever|nestl|britannia|marico|dabur|godrej consum|colgate|tata consum|emami|jyothy|gillette|p&g|procter|patanjali|bikaji|gopal snack|agarbathi|aroma|incense|personal care|toothpaste|soap limited/.test(n)) return "FMCG";
  // Food & beverage (broadened — sugar / dairy / tea / coffee / biscuit / agro-
  // processing / spice / poultry / nutraceuticals / edible oils). Catches the
  // long tail of small-cap food companies (ADFFOODS, sugar mills, dairy
  // co-ops) the NSE Industry doesn't disambiguate from generic "FMCG".
  if (/restaurant|food ?work|jubilant food|domino|westlife|devyani|sapphire|barbeque|kfc|pizza|sugar|distiller|sugars|dairy|amul|tea\b|tea limited|tea estates|tea compan|warren tea|jay shree tea|mcleod russel|coffee|biscuit|agro|nutrient|edible|spice|seeds|poultry|hatcher|fishery|cocoa|chocolate|bakery|confection|wineries|breweries|alcohol|brewing|liquor|spirits|atta|flour|rice mill|sweetener|frozen food|adf foods|ruchi soya|protein|animal feed|fish meal|snack|namkeen/.test(n)) return "Food";
  if (/retail|supermart|dmart|trent|shoppers stop|aditya birla fashion|v2 retail|vmart|departmental|stores limited/.test(n)) return "Retail";

  // Textiles — sprawling sector full of "Other" rows pre-Landing G.
  // Spinning / yarn / cotton / fabric / fibres / mills / weaving / garment /
  // ginning / denim / synthetics / silk / handloom — all collapse into a
  // single Textiles bucket the UI will eventually surface as a sector pill.
  if (/textil|yarn|spinning|cotton mill|cotton spinning|fabric|fibres|fibers|denim|garment|apparel|hosiery|knitting|weaving|polyester yarn|viscose|silk\b|jute\b|carpet|handloom|ginning|cotspin|spintex|fashions|laminat|airo lam|alok industries/.test(n)) return "Textiles";

  // Engineering / capital goods (machinery, forgings, fasteners, valves,
  // pistons, bearings, castings, gears, abrasives — most NSE small-caps in
  // this space land in "Other" because Total Market doesn't classify them).
  if (/engineer|machinery|forging|fastener|castings|castalloy|valves|piston|bearings|gears|abrasive|tool ?and ?die|pumps|compressor|turbine|boiler|switchgear|industrial automation|precision|welding|aluminum|sheet metal|fabrication|industrial corporation/.test(n)) return "Infrastructure";

  // Logistics / transport — shipping, ports, cargo, freight, express, movers,
  // warehousing, last-mile, container, trucking, supply chain, exim, exports.
  if (/logistic|shipping|cargo|freight|express|movers|warehous|container|trucking|supply chain|courier|3pl|distribution centre|exim|export limited|imports limited|trading limited|trade ?house/.test(n)) return "Services";

  // Education / e-learning.
  if (/educat|academy|school|university|institute|coaching|training|edutech/.test(n)) return "Services";

  // Aviation / hotels / media.
  if (/airline|aviation|airways|indigo|spicejet/.test(n)) return "Aviation";
  if (/hotel|resort|leisure|indian hotels|lemon tree|chalet|eih\b/.test(n)) return "Services";
  if (/media|broadcast|entertainment|television|news|publication|saregama|zee\b|sun tv|pvr|inox|cinevista|cinema|cineplex|prasar|multiplex|filmcraft/.test(n)) return "Services";
  // Travel / tour operators / casinos / gambling.
  if (/trip planner|tour operat|travels ?limited|easemytrip|holiday|cruise|casino|gaming|gambling|lottery|delta corp/.test(n)) return "Services";

  // Chemicals — extra leakage rules (organic / surfactant / alkali /
  // fluorochem / heranba / insecticides / nutraceutic-formulation /
  // remedies). Some pharma names actually make API/intermediates and read
  // more like specialty chem than drug-makers.
  if (/organic chem|surfactant|alkali|fluorochem|heranba|insecticides|specialty chem|polymer|adhesive|resins|catalyst|solvent|petrochem/.test(n)) return "Chemicals";

  // Diversified holding companies.
  if (/diversified|enterprises|holdings|conglomerate/.test(n)) return "Conglomerate";

  // Generic management / services / consultancy fall-through. Catches the
  // long tail of "21st Century Management Services" / "ABC Consultants"
  // style names that don't pattern-match any specific industry. Better
  // than dumping them in "Other" and uglier than misclassifying them as
  // a real industry.
  if (/services limited|consultancy|consultants|management services|advisory|investment manag|broking limited/.test(n)) return "Services";

  // Generic industrial / manufacturing fallback. Anything ending in
  // "Industries Limited", "Industrial Corporation", "Manufacturing", or
  // similar without a more-specific keyword above gets bucketed under
  // Infrastructure (capital goods is the closest umbrella). Reduces the
  // pre-Landing-G "Other" pile from 1,045 → ~150 by absorbing the SME
  // long tail without misclassifying anything famous.
  if (/industries limited|industrial limited|industrial corporation|manufacturing limited|manufactur|works limited/.test(n)) return "Infrastructure";

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

  // 3b. Layered sector overlays — 14 Nifty sectoral CSVs that pin a sector
  //     to every constituent regardless of what NSE Industry says. Higher-
  //     priority overlays win (we apply less-specific to more-specific so
  //     the last write sticks for ambiguous names like SBIN which is in
  //     PSU Banks AND Banking).
  //
  //     Total Market only covers ~750 symbols, so without these the long
  //     tail (~1,045 names) lands in "Other". Each sectoral list contributes
  //     30-100 symbols and refines the lookup table at zero cost.
  const SECTORAL_OVERLAYS = [
    { file: "ind_niftybanklist.csv",                sector: "Banking" },
    { file: "ind_niftyprivatebanklist.csv",         sector: "Banking" },
    { file: "ind_niftypsubanklist.csv",             sector: "Banking" },
    { file: "ind_niftyfinservicelist.csv",          sector: "NBFC" },
    { file: "ind_niftyfinservice25_50list.csv",     sector: "NBFC" },
    { file: "ind_niftyitlist.csv",                  sector: "IT Services" },
    { file: "ind_niftyautolist.csv",                sector: "Auto" },
    { file: "ind_niftypharmalist.csv",              sector: "Pharma" },
    { file: "ind_niftyhealthcarelist.csv",          sector: "Healthcare" },
    { file: "ind_niftyfmcglist.csv",                sector: "FMCG" },
    { file: "ind_niftyenergylist.csv",              sector: "Energy" },
    { file: "ind_niftymetallist.csv",               sector: "Metals" },
    { file: "ind_niftyrealtylist.csv",              sector: "Real Estate" },
    { file: "ind_niftymedialist.csv",               sector: "Services" },
    { file: "ind_niftyconsumerdurableslist.csv",    sector: "Consumer Elec" },
    { file: "ind_niftyoilgaslist.csv",              sector: "Energy" },
    { file: "ind_niftyinfralist.csv",               sector: "Infrastructure" },
    { file: "ind_niftypsuelist.csv",                sector: "Power" },
  ];
  const sectoralBySym = {};   // symbol → final sector after overlay layering
  for (const { file, sector } of SECTORAL_OVERLAYS) {
    try {
      const list = await fetchNiftyConstituents(file);
      for (const sym of list.syms) {
        // Last-overlay-wins. Order in SECTORAL_OVERLAYS is intentional —
        // PSU Banks list runs after Banking so SBIN ends up tagged Banking
        // (the more familiar bucket for users), then refineFinancialServices
        // re-narrows if needed.
        sectoralBySym[sym] = sector;
      }
    } catch (e) {
      console.warn(`[nifty] sectoral ${file} failed:`, e.message);
    }
  }
  console.log(`[nifty] sectoral overlays cover ${Object.keys(sectoralBySym).length} symbols`);

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
    // Sectoral overlay wins over the Total Market industry lookup ONLY when
    // the latter would land in "Other" — Total Market gives more specific
    // sub-industry data when it has the symbol; the overlays exist to
    // backstop the long tail. mapSector still runs the symbol-override +
    // refinement chain so SBIN/RELIANCE/etc. keep their hand-pinned values.
    let sector = mapSector(nseIndustry, symbol, name);
    if ((!sector || sector === "Other") && sectoralBySym[symbol]) {
      sector = sectoralBySym[symbol];
    }
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

  // 7. Write — produces FOUR artifacts so the front-end can opt into the
  //   immutable cache + brotli-q11 fast path:
  //     universeFull.json              — legacy path (still served)
  //     universeFull.<sha8>.json       — content-addressed copy, immutable cache
  //     universeFull.<sha8>.json.br    — brotli q11 (~5-15% smaller than q4-5)
  //     universeFull.meta.json         — small index (max-age 300) listing the
  //                                       current sha8 so universeLoader.js can
  //                                       resolve the immutable URL.
  // Vercel's edge auto-serves .br alongside the un-compressed file when the
  // request has Accept-Encoding: br, with Content-Encoding: br set.
  const json = JSON.stringify(out);
  const sha8 = crypto.createHash("sha256").update(json).digest("hex").slice(0, 8);
  const hashedJson = path.join(OUT_DIR, `universeFull.${sha8}.json`);
  const hashedBr   = path.join(OUT_DIR, `universeFull.${sha8}.json.br`);

  // Brotli q11 is the maximum quality (slow to compress but free at runtime).
  // For the ~470 KB universeFull.json this saves ~30 KB vs Vercel edge q4-5.
  const brBuf = await brotli(Buffer.from(json, "utf-8"), {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: json.length,
    },
  });

  // Clean up older hashed copies so the deployed bundle stays slim. Keep
  // ONLY files matching the current sha8.
  try {
    const existing = await fs.readdir(OUT_DIR);
    for (const f of existing) {
      const m = f.match(/^universeFull\.([0-9a-f]{8})\.json(\.br)?$/);
      if (m && m[1] !== sha8) {
        await fs.unlink(path.join(OUT_DIR, f)).catch(() => {});
      }
    }
  } catch (_) {}

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
    sha8,                                 // immutable URL: universeFull.<sha8>.json
    rawBytes: json.length,
    brotliBytes: brBuf.length,
  };

  await Promise.all([
    fs.writeFile(OUT_JSON, json),
    fs.writeFile(hashedJson, json),
    fs.writeFile(hashedBr, brBuf),
    fs.writeFile(OUT_META, JSON.stringify(meta, null, 2)),
  ]);
  console.log(`[build] wrote ${OUT_JSON} (${(json.length / 1024).toFixed(1)} KB)`);
  console.log(`[build] wrote ${hashedJson} (immutable, sha8=${sha8})`);
  console.log(`[build] wrote ${hashedBr} (${(brBuf.length / 1024).toFixed(1)} KB, brotli q11, saves ${(100 * (1 - brBuf.length / json.length)).toFixed(1)}%)`);
  console.log(`[build] wrote ${OUT_META}`);
}

main().catch(e => {
  console.error("[fatal]", e);
  process.exit(1);
});
