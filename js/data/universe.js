// =============================================================================
// UNIVERSE — 50 liquid, recognisable Indian equities + 10 popular MFs
// Prices stored in PAISE (integer math). Current price ≈ realistic late-2025 level.
// Sectors match NSE classification. Risk tier is a pedagogical simplification,
// NOT an investment grade.
// =============================================================================

export const STOCKS = [
  // Large-cap conglomerates
  { symbol: "RELIANCE",   name: "Reliance Industries",       sector: "Energy",        marketCap: "21.0L Cr", price: 313000, pe: 28.4, pb: 2.9, divYield: 0.35, beta: 0.95, risk: "low",  logo: "RIL" },
  { symbol: "TCS",        name: "Tata Consultancy Services", sector: "IT Services",   marketCap: "14.8L Cr", price: 410000, pe: 31.2, pb: 14.1, divYield: 1.40, beta: 0.85, risk: "low",  logo: "TCS" },
  { symbol: "HDFCBANK",   name: "HDFC Bank",                 sector: "Banking",       marketCap: "13.2L Cr", price: 174500, pe: 20.1, pb: 2.9, divYield: 1.05, beta: 0.98, risk: "low",  logo: "HDB" },
  { symbol: "INFY",       name: "Infosys",                   sector: "IT Services",   marketCap: "7.5L Cr",  price: 181200, pe: 28.6, pb: 9.3, divYield: 2.35, beta: 0.91, risk: "low",  logo: "INF" },
  { symbol: "ICICIBANK",  name: "ICICI Bank",                sector: "Banking",       marketCap: "9.3L Cr",  price: 133200, pe: 18.5, pb: 3.3, divYield: 0.80, beta: 1.04, risk: "low",  logo: "ICB" },
  { symbol: "BHARTIARTL", name: "Bharti Airtel",             sector: "Telecom",       marketCap: "8.8L Cr",  price: 158900, pe: 80.5, pb: 9.8, divYield: 0.55, beta: 0.79, risk: "med",  logo: "AIR" },
  { symbol: "SBIN",       name: "State Bank of India",       sector: "Banking",       marketCap: "7.4L Cr",  price:  82500, pe: 11.1, pb: 1.7, divYield: 1.55, beta: 1.12, risk: "med",  logo: "SBI" },
  { symbol: "ITC",        name: "ITC Limited",               sector: "FMCG",          marketCap: "5.5L Cr",  price:  44300, pe: 27.9, pb: 7.5, divYield: 3.35, beta: 0.72, risk: "low",  logo: "ITC" },
  { symbol: "LT",         name: "Larsen & Toubro",           sector: "Construction",  marketCap: "5.1L Cr",  price: 374200, pe: 36.8, pb: 5.4, divYield: 0.80, beta: 1.08, risk: "med",  logo: "L&T" },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever",        sector: "FMCG",          marketCap: "5.9L Cr",  price: 250500, pe: 55.1, pb: 9.7, divYield: 1.85, beta: 0.60, risk: "low",  logo: "HUL" },

  // Bank & financial
  { symbol: "AXISBANK",   name: "Axis Bank",                 sector: "Banking",       marketCap: "3.7L Cr",  price: 120700, pe: 13.6, pb: 2.2, divYield: 0.10, beta: 1.11, risk: "med",  logo: "AXB" },
  { symbol: "KOTAKBANK",  name: "Kotak Mahindra Bank",       sector: "Banking",       marketCap: "3.8L Cr",  price: 190500, pe: 18.8, pb: 2.8, divYield: 0.10, beta: 0.93, risk: "low",  logo: "KMB" },
  { symbol: "BAJFINANCE", name: "Bajaj Finance",             sector: "NBFC",          marketCap: "4.6L Cr",  price: 743000, pe: 30.4, pb: 5.7, divYield: 0.50, beta: 1.35, risk: "high", logo: "BJF" },
  { symbol: "HDFCLIFE",   name: "HDFC Life Insurance",       sector: "Insurance",     marketCap: "1.3L Cr",  price:  62000, pe: 79.8, pb: 8.1, divYield: 0.30, beta: 0.92, risk: "med",  logo: "HLI" },
  { symbol: "SBILIFE",    name: "SBI Life Insurance",        sector: "Insurance",     marketCap: "1.5L Cr",  price: 151200, pe: 79.2, pb: 9.4, divYield: 0.15, beta: 0.99, risk: "med",  logo: "SBL" },

  // IT / Tech
  { symbol: "HCLTECH",    name: "HCL Technologies",          sector: "IT Services",   marketCap: "4.3L Cr",  price: 159200, pe: 26.2, pb: 5.8, divYield: 3.20, beta: 0.85, risk: "low",  logo: "HCL" },
  { symbol: "WIPRO",      name: "Wipro",                     sector: "IT Services",   marketCap: "2.6L Cr",  price:  50200, pe: 24.8, pb: 3.5, divYield: 0.20, beta: 0.82, risk: "low",  logo: "WIP" },
  { symbol: "TECHM",      name: "Tech Mahindra",             sector: "IT Services",   marketCap: "1.5L Cr",  price: 157300, pe: 40.4, pb: 4.6, divYield: 2.90, beta: 0.88, risk: "med",  logo: "TEM" },
  { symbol: "LTIM",       name: "LTIMindtree",               sector: "IT Services",   marketCap: "1.5L Cr",  price: 498200, pe: 32.6, pb: 7.0, divYield: 1.40, beta: 0.96, risk: "med",  logo: "LTM" },

  // Auto
  { symbol: "MARUTI",     name: "Maruti Suzuki India",       sector: "Auto",          marketCap: "4.0L Cr",  price:1278000, pe: 29.1, pb: 4.4, divYield: 0.95, beta: 0.87, risk: "med",  logo: "MSI" },
  { symbol: "TATAMOTORS", name: "Tata Motors",               sector: "Auto",          marketCap: "3.2L Cr",  price:  85500, pe: 11.8, pb: 3.6, divYield: 0.35, beta: 1.42, risk: "high", logo: "TTM" },
  { symbol: "M&M",        name: "Mahindra & Mahindra",       sector: "Auto",          marketCap: "3.7L Cr",  price: 297500, pe: 28.4, pb: 4.0, divYield: 0.55, beta: 1.08, risk: "med",  logo: "M&M" },
  { symbol: "EICHERMOT",  name: "Eicher Motors",             sector: "Auto",          marketCap: "1.3L Cr",  price: 475800, pe: 31.5, pb: 6.4, divYield: 1.10, beta: 1.04, risk: "med",  logo: "EIC" },
  { symbol: "BAJAJ-AUTO", name: "Bajaj Auto",                sector: "Auto",          marketCap: "2.5L Cr",  price: 884500, pe: 34.4, pb: 7.7, divYield: 1.90, beta: 0.91, risk: "med",  logo: "BJA" },

  // Metals & energy
  { symbol: "TATASTEEL",  name: "Tata Steel",                sector: "Metals",        marketCap: "1.9L Cr",  price:  15500, pe: 24.8, pb: 2.1, divYield: 2.30, beta: 1.32, risk: "high", logo: "TSL" },
  { symbol: "JSWSTEEL",   name: "JSW Steel",                 sector: "Metals",        marketCap: "2.3L Cr",  price:  95700, pe: 32.0, pb: 2.9, divYield: 0.80, beta: 1.35, risk: "high", logo: "JSW" },
  { symbol: "HINDALCO",   name: "Hindalco Industries",       sector: "Metals",        marketCap: "1.4L Cr",  price:  63500, pe: 11.9, pb: 1.5, divYield: 0.80, beta: 1.41, risk: "high", logo: "HAL" },
  { symbol: "COALINDIA",  name: "Coal India",                sector: "Energy",        marketCap: "2.6L Cr",  price:  42000, pe:  7.1, pb: 3.2, divYield: 5.95, beta: 0.80, risk: "med",  logo: "COL" },
  { symbol: "ONGC",       name: "ONGC",                      sector: "Energy",        marketCap: "3.2L Cr",  price:  25400, pe:  6.8, pb: 1.0, divYield: 4.85, beta: 1.15, risk: "med",  logo: "ONG" },
  { symbol: "NTPC",       name: "NTPC",                      sector: "Power",         marketCap: "3.6L Cr",  price:  37400, pe: 17.1, pb: 2.1, divYield: 1.95, beta: 0.89, risk: "low",  logo: "NTP" },
  { symbol: "POWERGRID",  name: "Power Grid Corp.",          sector: "Power",         marketCap: "3.0L Cr",  price:  32400, pe: 18.0, pb: 3.1, divYield: 3.40, beta: 0.62, risk: "low",  logo: "PGC" },

  // FMCG & Consumer
  { symbol: "NESTLEIND",  name: "Nestlé India",              sector: "FMCG",          marketCap: "2.4L Cr",  price: 247000, pe: 74.5, pb: 67.5, divYield: 1.10, beta: 0.55, risk: "low",  logo: "NES" },
  { symbol: "BRITANNIA",  name: "Britannia Industries",      sector: "FMCG",          marketCap: "1.3L Cr",  price: 556000, pe: 58.1, pb: 36.0, divYield: 1.40, beta: 0.68, risk: "low",  logo: "BRT" },
  { symbol: "DABUR",      name: "Dabur India",               sector: "FMCG",          marketCap: "1.0L Cr",  price:  56500, pe: 53.4, pb: 10.3, divYield: 1.10, beta: 0.58, risk: "low",  logo: "DAB" },
  { symbol: "TITAN",      name: "Titan Company",             sector: "Consumer",      marketCap: "3.1L Cr",  price: 346000, pe: 90.6, pb: 32.5, divYield: 0.30, beta: 1.03, risk: "med",  logo: "TTN" },
  { symbol: "ASIANPAINT", name: "Asian Paints",              sector: "Consumer",      marketCap: "2.2L Cr",  price: 227500, pe: 55.3, pb: 15.1, divYield: 1.40, beta: 0.77, risk: "low",  logo: "ASP" },

  // Pharma
  { symbol: "SUNPHARMA",  name: "Sun Pharmaceutical",        sector: "Pharma",        marketCap: "3.8L Cr",  price: 159000, pe: 38.7, pb: 5.7, divYield: 0.65, beta: 0.69, risk: "low",  logo: "SUN" },
  { symbol: "DRREDDY",    name: "Dr. Reddy's Laboratories",  sector: "Pharma",        marketCap: "1.1L Cr",  price: 123000, pe: 21.6, pb: 3.7, divYield: 0.35, beta: 0.64, risk: "low",  logo: "DRD" },
  { symbol: "CIPLA",      name: "Cipla",                     sector: "Pharma",        marketCap: "1.2L Cr",  price: 145000, pe: 27.0, pb: 3.9, divYield: 0.90, beta: 0.66, risk: "low",  logo: "CPL" },
  { symbol: "DIVISLAB",   name: "Divi's Laboratories",       sector: "Pharma",        marketCap: "1.5L Cr",  price: 572000, pe: 81.8, pb: 7.5, divYield: 0.55, beta: 0.78, risk: "med",  logo: "DIV" },

  // Cement & construction
  { symbol: "ULTRACEMCO", name: "UltraTech Cement",          sector: "Cement",        marketCap: "3.2L Cr",  price:1104000, pe: 48.5, pb: 5.6, divYield: 0.65, beta: 0.99, risk: "med",  logo: "UTC" },
  { symbol: "GRASIM",     name: "Grasim Industries",         sector: "Conglomerate",  marketCap: "1.7L Cr",  price: 254000, pe: 29.8, pb: 1.9, divYield: 0.40, beta: 1.07, risk: "med",  logo: "GRA" },

  // New age / disruptors
  { symbol: "ZOMATO",     name: "Zomato",                    sector: "Internet",      marketCap: "2.1L Cr",  price:  23800, pe: 280,  pb: 9.1, divYield: 0.00, beta: 1.38, risk: "high", logo: "ZOM" },
  { symbol: "PAYTM",      name: "One97 / Paytm",             sector: "Fintech",       marketCap: "0.6L Cr",  price:  95500, pe: null, pb: 4.2, divYield: 0.00, beta: 1.62, risk: "high", logo: "PYT" },
  { symbol: "NYKAA",      name: "FSN E-Commerce / Nykaa",    sector: "Internet",      marketCap: "0.6L Cr",  price:  20500, pe: 730,  pb: 18.5, divYield: 0.00, beta: 1.41, risk: "high", logo: "NYK" },
  { symbol: "POLICYBZR",  name: "PB Fintech / Policybazaar", sector: "Fintech",       marketCap: "0.8L Cr",  price: 185000, pe: null, pb: 12.1, divYield: 0.00, beta: 1.55, risk: "high", logo: "PBZ" },
  { symbol: "DMART",      name: "Avenue Supermarts (DMart)", sector: "Retail",        marketCap: "2.8L Cr",  price: 430000, pe: 101,  pb: 15.7, divYield: 0.00, beta: 0.76, risk: "med",  logo: "DMT" },

  // More large caps
  { symbol: "ADANIENT",   name: "Adani Enterprises",         sector: "Conglomerate",  marketCap: "2.9L Cr",  price: 252000, pe: 92.3, pb: 9.1, divYield: 0.05, beta: 1.92, risk: "high", logo: "ADE" },
  { symbol: "ADANIPORTS", name: "Adani Ports & SEZ",         sector: "Infrastructure",marketCap: "2.5L Cr",  price: 116000, pe: 31.2, pb: 4.9, divYield: 0.45, beta: 1.52, risk: "high", logo: "ADP" },
  { symbol: "IRCTC",      name: "IRCTC",                     sector: "Services",      marketCap: "0.6L Cr",  price:  72500, pe: 51.7, pb: 14.3, divYield: 0.95, beta: 0.89, risk: "med",  logo: "IRC" },
];

export const MUTUAL_FUNDS = [
  { symbol: "MF_NIFTY50_INDEX",  name: "UTI Nifty 50 Index Fund",          category: "Index",    expenseRatio: 0.21, nav: 16840, risk: "low",  aum: "18,500 Cr", bench: "NIFTY 50" },
  { symbol: "MF_SENSEX_INDEX",   name: "HDFC Sensex Index Fund",            category: "Index",    expenseRatio: 0.30, nav: 68920, risk: "low",  aum: "9,800 Cr",  bench: "SENSEX" },
  { symbol: "MF_NIFTY_NEXT_50",  name: "ICICI Pru Nifty Next 50 Index Fund",category: "Index",    expenseRatio: 0.38, nav: 58200, risk: "med",  aum: "3,600 Cr",  bench: "NIFTY Next 50" },
  { symbol: "MF_PARAG_FLEXI",    name: "Parag Parikh Flexi Cap Fund",       category: "Equity",   expenseRatio: 0.62, nav: 85400, risk: "med",  aum: "80,000 Cr", bench: "NIFTY 500" },
  { symbol: "MF_MIRAE_LARGE",    name: "Mirae Asset Large Cap Fund",        category: "Equity",   expenseRatio: 1.58, nav: 96300, risk: "med",  aum: "38,000 Cr", bench: "NIFTY 100" },
  { symbol: "MF_AXIS_SMALL",     name: "Axis Small Cap Fund",               category: "Equity",   expenseRatio: 1.72, nav: 94200, risk: "high", aum: "22,000 Cr", bench: "NIFTY SmallCap 250" },
  { symbol: "MF_SBI_BLUECHIP",   name: "SBI Bluechip Fund",                 category: "Equity",   expenseRatio: 1.54, nav: 92100, risk: "med",  aum: "48,000 Cr", bench: "BSE 100" },
  { symbol: "MF_HDFC_BALANCED",  name: "HDFC Balanced Advantage Fund",      category: "Hybrid",   expenseRatio: 1.33, nav: 52200, risk: "med",  aum: "90,000 Cr", bench: "CRISIL Hybrid" },
  { symbol: "MF_ICICI_LIQUID",   name: "ICICI Pru Liquid Fund",             category: "Debt",     expenseRatio: 0.20, nav: 38200, risk: "low",  aum: "55,000 Cr", bench: "CRISIL Liquid" },
  { symbol: "MF_NIPPON_GOLD",    name: "Nippon India Gold Savings Fund",    category: "Gold",     expenseRatio: 0.32, nav: 31500, risk: "med",  aum: "3,200 Cr",  bench: "Domestic Gold" },
];

export const INSTRUMENTS = [
  ...STOCKS.map(s => ({ ...s, kind: "EQUITY" })),
  ...MUTUAL_FUNDS.map(m => ({ ...m, kind: "MF", price: m.nav })),
];

export const SECTORS = [...new Set(STOCKS.map(s => s.sector))].sort();

export const INSTRUMENT_BY_SYMBOL = Object.fromEntries(
  INSTRUMENTS.map(i => [i.symbol, i])
);

export function getInstrument(symbol) {
  return INSTRUMENT_BY_SYMBOL[symbol];
}

// Sensible defaults for onboarding — a seeded ₹1L "balanced" teen portfolio
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
    { symbol: "TATAMOTORS",  qty: 20 },
    { symbol: "ZOMATO",      qty: 100 },
    { symbol: "ADANIENT",    qty: 5 },
    { symbol: "RELIANCE",    qty: 5 },
    { symbol: "BAJFINANCE",  qty: 2 },
    { symbol: "PAYTM",       qty: 15 },
  ],
};
