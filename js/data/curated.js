// =============================================================================
// CURATED — featured symbols + onboarding portfolios. NO HAND-TYPED DATA.
//
// User's hard rule: zero hand-typed values. Every numerical field (sector,
// marketCap, PE, PB, beta, divYield, risk, logo, price) comes from automated
// sources:
//   - Sector / industry / risk / cap_bucket: build-universe.mjs (NSE
//     classification + Nifty sectoral CSVs + name keyword regex + Yahoo
//     assetProfile via crumb)
//   - market_cap, PE, PB, beta, divYield, EPS: /api/fundamentals (Yahoo
//     crumb + Tickertape, cached in Supabase fundamentals_cache)
//   - Price / OHLC / 52W: /api/quote, /api/history (Yahoo v8/chart)
//   - Logo: algorithmic (first 3 chars of symbol)
//
// This file is now metadata-only — it only owns:
//   1. FEATURED_SYMBOLS — which tickers should appear at the top of the
//      Stocks tab on cold load (before market-cap sort kicks in)
//   2. ONBOARDING_PORTFOLIOS — UX choice for cautious / balanced / bold
//      starter packs
// =============================================================================

// Featured tickers — large/mid-cap stocks Indian users recognize. Used only
// for cold-load display ordering before sort/filter takes over. The actual
// sector/marketCap/PE/etc. for each comes from /api/fundamentals at runtime.
export const FEATURED_SYMBOLS = [
  // Mega caps (Nifty 50)
  "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "BHARTIARTL", "SBIN",
  "ITC", "LT", "HINDUNILVR", "AXISBANK", "KOTAKBANK", "BAJFINANCE", "HCLTECH",
  "MARUTI", "SUNPHARMA", "ASIANPAINT", "TITAN", "BAJAJFINSV", "NESTLEIND",
  "ULTRACEMCO", "WIPRO", "ONGC", "NTPC", "POWERGRID", "TATASTEEL", "JSWSTEEL",
  "HINDALCO", "COALINDIA", "M&M", "TMPV", "TMCV", "EICHERMOT", "BAJAJ-AUTO",
  "TECHM", "LTIM", "DRREDDY", "CIPLA", "DIVISLAB", "GRASIM", "ADANIENT",
  "ADANIPORTS", "HDFCLIFE", "SBILIFE", "BRITANNIA", "TATACONSUM", "INDUSINDBK",
  "HEROMOTOCO", "APOLLOHOSP", "TATAMOTORS",
  // Internet / fintech
  "ETERNAL", "PAYTM", "NYKAA", "POLICYBZR", "DMART",
  // High-volume mid-caps
  "TRENT", "VBL", "DLF", "PIDILITIND", "GODREJCP", "HAVELLS", "PERSISTENT",
  "CHOLAFIN", "MOTHERSON", "AMBUJACEM", "TVSMOTOR", "SIEMENS", "IRCTC",
  "BPCL", "IOC", "GAIL", "ADANIGREEN", "ADANIPOWER", "VEDL", "TATAPOWER",
  "INDIGO", "BANKBARODA", "PNB", "CANBK", "FEDERALBNK", "IDFCFIRSTB",
  "HDFCAMC", "SBICARD", "ICICIPRULI", "LICI", "BAJAJHLDNG",
  // PSU + infra
  "IRFC", "RECLTD", "PFC", "HINDPETRO", "POWERINDIA",
  // Pharma extra
  "AUROPHARMA", "LUPIN", "BIOCON", "TORNTPHARM", "ALKEM",
  // Cement extra
  "SHREECEM", "ACC",
  // Real estate
  "GODREJPROP", "LODHA", "OBEROIRLTY",
  // Healthcare
  "MAXHEALTH", "FORTIS",
  // FMCG / consumer extra
  "MARICO", "DABUR", "COLPAL", "UBL", "UNITDSPR", "BERGEPAINT", "PAGEIND",
  "JUBLFOOD", "VOLTAS", "WHIRLPOOL", "DIXON", "POLYCAB",
  // Telecom extra
  "TATACOMM",
];

// Featured MUTUAL_FUNDS — kept as bare AMFI scheme codes until Landing G
// imports the full ~5,000-scheme AMFI universe. ONBOARDING_PORTFOLIOS
// references these symbols. Once mfFull.json is wired, these become just
// pointers into that catalog (same pattern as FEATURED_SYMBOLS for stocks).
export const FEATURED_MF_CODES = [
  "MF_NIFTY50_INDEX",     // UTI Nifty 50 Index Fund (placeholder until AMFI lands)
  "MF_SENSEX_INDEX",
  "MF_NIFTY_NEXT_50",
  "MF_PARAG_FLEXI",
  "MF_MIRAE_LARGE",
  "MF_AXIS_SMALL",
  "MF_SBI_BLUECHIP",
  "MF_HDFC_BALANCED",
  "MF_ICICI_LIQUID",
  "MF_NIPPON_GOLD",
];

// Stub MF metadata kept ONLY because onboarding portfolios reference these
// symbols and we need SOME shape to render before Landing G replaces this
// with a Supabase mf_master query. After Landing G this whole block is
// removed and onboarding portfolios reference real AMFI scheme codes
// (e.g. "MF_120503" for HDFC Index Nifty 50 Direct Plan).
//
// IMPORTANT: this is the LAST hand-typed data block in the codebase. Tagged
// for removal in Landing G when AMFI scheme codes replace these placeholders.
export const PLACEHOLDER_MFS = [
  { symbol: "MF_NIFTY50_INDEX",  name: "Nifty 50 Index Fund (placeholder)",   category: "Index",   risk: "low",  bench: "NIFTY 50",         placeholder: true },
  { symbol: "MF_SENSEX_INDEX",   name: "Sensex Index Fund (placeholder)",     category: "Index",   risk: "low",  bench: "SENSEX",           placeholder: true },
  { symbol: "MF_NIFTY_NEXT_50",  name: "Nifty Next 50 Index Fund (placeholder)", category: "Index", risk: "med", bench: "NIFTY Next 50",   placeholder: true },
  { symbol: "MF_PARAG_FLEXI",    name: "Parag Parikh Flexi Cap (placeholder)",category: "Equity",  risk: "med",  bench: "NIFTY 500",        placeholder: true },
  { symbol: "MF_MIRAE_LARGE",    name: "Mirae Asset Large Cap (placeholder)", category: "Equity",  risk: "med",  bench: "NIFTY 100",        placeholder: true },
  { symbol: "MF_AXIS_SMALL",     name: "Axis Small Cap (placeholder)",        category: "Equity",  risk: "high", bench: "NIFTY SmallCap 250",placeholder: true },
  { symbol: "MF_SBI_BLUECHIP",   name: "SBI Bluechip (placeholder)",          category: "Equity",  risk: "med",  bench: "BSE 100",          placeholder: true },
  { symbol: "MF_HDFC_BALANCED",  name: "HDFC Balanced Advantage (placeholder)",category:"Hybrid",  risk: "med",  bench: "CRISIL Hybrid",    placeholder: true },
  { symbol: "MF_ICICI_LIQUID",   name: "ICICI Pru Liquid (placeholder)",      category: "Debt",    risk: "low",  bench: "CRISIL Liquid",    placeholder: true },
  { symbol: "MF_NIPPON_GOLD",    name: "Nippon Gold Savings (placeholder)",   category: "Gold",    risk: "med",  bench: "Domestic Gold",    placeholder: true },
];

// Onboarding starter portfolios — UX choice (which symbols + how many units),
// not data. The actual price + market cap of each holding comes from
// /api/quote and /api/fundamentals at runtime.
export const ONBOARDING_PORTFOLIOS = {
  cautious: [
    { symbol: "MF_NIFTY50_INDEX", qty: 3.0 },
    { symbol: "MF_HDFC_BALANCED", qty: 3.0 },
    { symbol: "HDFCBANK",         qty: 5 },
    { symbol: "TCS",              qty: 2 },
  ],
  balanced: [
    { symbol: "RELIANCE",         qty: 8 },
    { symbol: "TCS",              qty: 3 },
    { symbol: "HDFCBANK",         qty: 10 },
    { symbol: "INFY",             qty: 6 },
    { symbol: "ITC",              qty: 40 },
    { symbol: "MF_NIFTY50_INDEX", qty: 1.5 },
  ],
  bold: [
    { symbol: "TMPV",        qty: 20 },
    { symbol: "ETERNAL",     qty: 100 },
    { symbol: "ADANIENT",    qty: 5 },
    { symbol: "RELIANCE",    qty: 5 },
    { symbol: "BAJFINANCE",  qty: 2 },
    { symbol: "PAYTM",       qty: 15 },
  ],
};
