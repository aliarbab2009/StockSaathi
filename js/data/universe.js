// =============================================================================
// UNIVERSE — 50 liquid, recognisable Indian equities + 10 popular MFs
// Prices stored in PAISE (integer math). Current price ≈ realistic late-2025 level.
// Sectors match NSE classification. Risk tier is a pedagogical simplification,
// NOT an investment grade.
// =============================================================================

export const STOCKS = [
  // Large-cap conglomerates
  // Post 1:1 bonus issue (Oct 2024) — share count doubled, price halved. The
  // old 313000 paise (₹3,130) fallback paints pre-bonus data for anyone who
  // loads the page while the Yahoo proxy is unreachable.
  { symbol: "RELIANCE",   name: "Reliance Industries",       sector: "Energy",        marketCap: "18.5L Cr", price: 136490, pe: 25.4, pb: 2.1, divYield: 0.35, beta: 0.95, risk: "low",  logo: "RIL" },
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

  // Additional NIFTY 200 names
  { symbol: "HDFCAMC",    name: "HDFC Asset Management",     sector: "NBFC",          marketCap: "0.8L Cr",  price: 380000, pe: 32.8, pb: 8.5, divYield: 2.20, beta: 0.88, risk: "low",  logo: "HAM" },
  { symbol: "SBICARD",    name: "SBI Cards & Payment",       sector: "NBFC",          marketCap: "0.7L Cr",  price:  68500, pe: 25.1, pb: 4.3, divYield: 0.35, beta: 1.23, risk: "med",  logo: "SBC" },
  { symbol: "CHOLAFIN",   name: "Cholamandalam Finance",     sector: "NBFC",          marketCap: "1.0L Cr",  price: 130000, pe: 28.5, pb: 4.4, divYield: 0.15, beta: 1.32, risk: "med",  logo: "CHO" },
  { symbol: "BAJAJFINSV", name: "Bajaj Finserv",             sector: "NBFC",          marketCap: "2.5L Cr",  price: 156000, pe: 35.2, pb: 3.8, divYield: 0.05, beta: 1.28, risk: "med",  logo: "BJV" },
  { symbol: "INDUSINDBK", name: "IndusInd Bank",             sector: "Banking",       marketCap: "1.0L Cr",  price: 130000, pe: 11.5, pb: 1.4, divYield: 1.20, beta: 1.42, risk: "high", logo: "IIB" },
  { symbol: "IDFCFIRSTB", name: "IDFC First Bank",           sector: "Banking",       marketCap: "0.5L Cr",  price:   6800, pe: 18.5, pb: 1.5, divYield: 0.00, beta: 1.38, risk: "high", logo: "IDF" },
  { symbol: "BANDHANBNK", name: "Bandhan Bank",              sector: "Banking",       marketCap: "0.3L Cr",  price:  18500, pe: 8.5, pb: 1.1, divYield: 0.85, beta: 1.42, risk: "high", logo: "BDN" },
  { symbol: "FEDERALBNK", name: "Federal Bank",              sector: "Banking",       marketCap: "0.5L Cr",  price:  20500, pe: 8.8, pb: 1.1, divYield: 1.40, beta: 1.18, risk: "med",  logo: "FED" },
  { symbol: "PNB",        name: "Punjab National Bank",      sector: "Banking",       marketCap: "1.2L Cr",  price:  10200, pe: 8.2, pb: 0.8, divYield: 1.50, beta: 1.35, risk: "high", logo: "PNB" },
  { symbol: "BANKBARODA", name: "Bank of Baroda",            sector: "Banking",       marketCap: "1.4L Cr",  price:  27500, pe: 7.4, pb: 0.9, divYield: 2.75, beta: 1.28, risk: "med",  logo: "BOB" },
  { symbol: "CANBK",      name: "Canara Bank",               sector: "Banking",       marketCap: "1.0L Cr",  price:  11200, pe: 6.2, pb: 0.9, divYield: 3.10, beta: 1.30, risk: "med",  logo: "CAN" },

  { symbol: "GODREJCP",   name: "Godrej Consumer Products",  sector: "FMCG",          marketCap: "1.3L Cr",  price: 125000, pe: 62.1, pb: 8.8, divYield: 0.80, beta: 0.62, risk: "low",  logo: "GCP" },
  { symbol: "MARICO",     name: "Marico",                    sector: "FMCG",          marketCap: "0.9L Cr",  price:  69500, pe: 50.8, pb: 18.5, divYield: 1.35, beta: 0.55, risk: "low",  logo: "MRC" },
  { symbol: "COLPAL",     name: "Colgate-Palmolive India",   sector: "FMCG",          marketCap: "0.9L Cr",  price: 330000, pe: 50.2, pb: 45.3, divYield: 2.60, beta: 0.58, risk: "low",  logo: "CPL" },
  { symbol: "PGHH",       name: "Procter & Gamble Hygiene",  sector: "FMCG",          marketCap: "0.6L Cr",  price:1850000, pe: 80.2, pb: 72.0, divYield: 2.20, beta: 0.50, risk: "low",  logo: "PGH" },
  { symbol: "UBL",        name: "United Breweries",          sector: "FMCG",          marketCap: "0.5L Cr",  price: 200000, pe: 108, pb: 11.8, divYield: 0.30, beta: 0.72, risk: "med",  logo: "UBL" },

  { symbol: "TVSMOTOR",   name: "TVS Motor",                 sector: "Auto",          marketCap: "1.3L Cr",  price: 280000, pe: 48.5, pb: 12.2, divYield: 0.35, beta: 1.12, risk: "med",  logo: "TVS" },
  { symbol: "HEROMOTOCO", name: "Hero MotoCorp",             sector: "Auto",          marketCap: "1.1L Cr",  price: 556000, pe: 20.5, pb: 4.6, divYield: 2.15, beta: 0.88, risk: "med",  logo: "HRO" },
  { symbol: "ASHOKLEY",   name: "Ashok Leyland",             sector: "Auto",          marketCap: "0.6L Cr",  price:  21000, pe: 24.1, pb: 4.5, divYield: 1.25, beta: 1.30, risk: "med",  logo: "ASH" },
  { symbol: "BOSCHLTD",   name: "Bosch",                     sector: "Auto",          marketCap: "1.0L Cr",  price:3150000, pe: 42.5, pb: 6.8, divYield: 0.75, beta: 0.85, risk: "med",  logo: "BSH" },

  { symbol: "AUROPHARMA", name: "Aurobindo Pharma",          sector: "Pharma",        marketCap: "0.8L Cr",  price: 135000, pe: 18.5, pb: 2.5, divYield: 0.35, beta: 0.82, risk: "med",  logo: "AUR" },
  { symbol: "LUPIN",      name: "Lupin",                     sector: "Pharma",        marketCap: "0.9L Cr",  price: 200000, pe: 38.2, pb: 4.1, divYield: 0.45, beta: 0.74, risk: "med",  logo: "LPN" },
  { symbol: "BIOCON",     name: "Biocon",                    sector: "Pharma",        marketCap: "0.4L Cr",  price:  35500, pe: 65.5, pb: 2.1, divYield: 0.60, beta: 0.88, risk: "med",  logo: "BIO" },
  { symbol: "TORNTPHARM", name: "Torrent Pharma",            sector: "Pharma",        marketCap: "1.0L Cr",  price: 295000, pe: 65.1, pb: 14.5, divYield: 0.95, beta: 0.65, risk: "low",  logo: "TRP" },
  { symbol: "ALKEM",      name: "Alkem Laboratories",        sector: "Pharma",        marketCap: "0.6L Cr",  price: 510000, pe: 35.1, pb: 5.2, divYield: 0.85, beta: 0.60, risk: "low",  logo: "ALK" },

  { symbol: "SHREECEM",   name: "Shree Cement",              sector: "Cement",        marketCap: "1.0L Cr",  price:2750000, pe: 50.2, pb: 4.2, divYield: 0.35, beta: 0.92, risk: "med",  logo: "SHC" },
  { symbol: "AMBUJACEM",  name: "Ambuja Cements",            sector: "Cement",        marketCap: "1.4L Cr",  price:  55500, pe: 52.8, pb: 4.1, divYield: 0.45, beta: 1.05, risk: "med",  logo: "AMB" },
  { symbol: "ACC",        name: "ACC",                       sector: "Cement",        marketCap: "0.4L Cr",  price: 215000, pe: 32.1, pb: 3.2, divYield: 0.95, beta: 1.08, risk: "med",  logo: "ACC" },

  { symbol: "DLF",        name: "DLF",                       sector: "Real Estate",   marketCap: "2.0L Cr",  price:  80000, pe: 65.2, pb: 4.1, divYield: 0.65, beta: 1.28, risk: "med",  logo: "DLF" },
  { symbol: "GODREJPROP", name: "Godrej Properties",         sector: "Real Estate",   marketCap: "0.7L Cr",  price: 245000, pe: 99.5, pb: 5.2, divYield: 0.00, beta: 1.22, risk: "high", logo: "GRP" },
  { symbol: "LODHA",      name: "Macrotech / Lodha",         sector: "Real Estate",   marketCap: "1.3L Cr",  price: 130000, pe: 52.1, pb: 5.5, divYield: 0.15, beta: 1.30, risk: "high", logo: "LDA" },
  { symbol: "OBEROIRLTY", name: "Oberoi Realty",             sector: "Real Estate",   marketCap: "0.7L Cr",  price: 180000, pe: 35.2, pb: 4.1, divYield: 0.15, beta: 1.15, risk: "med",  logo: "OBR" },

  { symbol: "GAIL",       name: "GAIL (India)",              sector: "Energy",        marketCap: "1.3L Cr",  price:  20500, pe: 12.8, pb: 1.5, divYield: 3.50, beta: 0.95, risk: "med",  logo: "GAL" },
  { symbol: "IOC",        name: "Indian Oil Corporation",    sector: "Energy",        marketCap: "1.9L Cr",  price:  13500, pe: 10.2, pb: 1.0, divYield: 6.20, beta: 1.10, risk: "med",  logo: "IOC" },
  { symbol: "BPCL",       name: "Bharat Petroleum",          sector: "Energy",        marketCap: "1.5L Cr",  price:  34500, pe: 8.5, pb: 1.8, divYield: 3.85, beta: 1.12, risk: "med",  logo: "BPC" },
  { symbol: "HINDPETRO",  name: "Hindustan Petroleum",       sector: "Energy",        marketCap: "0.8L Cr",  price:  38500, pe: 6.2, pb: 1.6, divYield: 5.10, beta: 1.20, risk: "med",  logo: "HPC" },
  { symbol: "TATAPOWER",  name: "Tata Power",                sector: "Power",         marketCap: "1.4L Cr",  price:  42500, pe: 45.2, pb: 3.8, divYield: 0.45, beta: 1.18, risk: "med",  logo: "TTP" },
  { symbol: "ADANIGREEN", name: "Adani Green Energy",        sector: "Power",         marketCap: "2.3L Cr",  price: 150000, pe: 225,  pb: 25.0, divYield: 0.00, beta: 1.85, risk: "high", logo: "AGE" },
  { symbol: "ADANIPOWER", name: "Adani Power",               sector: "Power",         marketCap: "2.2L Cr",  price:  57500, pe: 18.5, pb: 4.2, divYield: 0.00, beta: 1.65, risk: "high", logo: "APW" },

  { symbol: "APOLLOHOSP", name: "Apollo Hospitals",          sector: "Healthcare",    marketCap: "1.0L Cr",  price: 720000, pe: 95.2, pb: 12.8, divYield: 0.20, beta: 0.72, risk: "med",  logo: "APH" },
  { symbol: "MAXHEALTH",  name: "Max Healthcare",            sector: "Healthcare",    marketCap: "1.1L Cr",  price: 115000, pe: 100, pb: 9.5, divYield: 0.00, beta: 0.78, risk: "med",  logo: "MXH" },
  { symbol: "FORTIS",     name: "Fortis Healthcare",         sector: "Healthcare",    marketCap: "0.5L Cr",  price:  68500, pe: 70.1, pb: 6.2, divYield: 0.25, beta: 0.82, risk: "med",  logo: "FRT" },

  { symbol: "ICICIPRULI", name: "ICICI Prudential Life",     sector: "Insurance",     marketCap: "1.0L Cr",  price:  72000, pe: 82.8, pb: 7.2, divYield: 0.25, beta: 0.95, risk: "med",  logo: "IPL" },
  { symbol: "LICI",       name: "LIC of India",              sector: "Insurance",     marketCap: "7.0L Cr",  price: 112000, pe: 15.5, pb: 6.5, divYield: 0.90, beta: 1.10, risk: "med",  logo: "LIC" },

  { symbol: "JINDALSTEL", name: "Jindal Steel & Power",      sector: "Metals",        marketCap: "0.9L Cr",  price:  88500, pe: 20.2, pb: 1.9, divYield: 0.25, beta: 1.45, risk: "high", logo: "JSP" },
  { symbol: "SAIL",       name: "Steel Authority of India",  sector: "Metals",        marketCap: "0.5L Cr",  price:  11500, pe: 18.5, pb: 0.9, divYield: 1.80, beta: 1.40, risk: "high", logo: "SAL" },
  { symbol: "VEDL",       name: "Vedanta",                   sector: "Metals",        marketCap: "1.8L Cr",  price:  48500, pe: 28.2, pb: 3.2, divYield: 9.50, beta: 1.52, risk: "high", logo: "VED" },
  { symbol: "NMDC",       name: "NMDC",                      sector: "Metals",        marketCap: "0.7L Cr",  price:  24500, pe: 10.2, pb: 2.5, divYield: 3.20, beta: 1.22, risk: "med",  logo: "NMD" },

  { symbol: "HAVELLS",    name: "Havells India",             sector: "Consumer Elec", marketCap: "1.1L Cr",  price: 180000, pe: 75.2, pb: 13.5, divYield: 0.55, beta: 0.88, risk: "med",  logo: "HVL" },
  { symbol: "VOLTAS",     name: "Voltas",                    sector: "Consumer Elec", marketCap: "0.6L Cr",  price: 180000, pe: 92.5, pb: 7.5, divYield: 0.25, beta: 1.05, risk: "med",  logo: "VLT" },
  { symbol: "WHIRLPOOL",  name: "Whirlpool of India",        sector: "Consumer Elec", marketCap: "0.2L Cr",  price: 170000, pe: 80.5, pb: 5.8, divYield: 0.30, beta: 0.92, risk: "med",  logo: "WPL" },

  { symbol: "PIDILITIND", name: "Pidilite Industries",       sector: "Chemicals",     marketCap: "1.6L Cr",  price: 310000, pe: 82.5, pb: 19.2, divYield: 0.70, beta: 0.55, risk: "low",  logo: "PID" },
  { symbol: "SRF",        name: "SRF",                       sector: "Chemicals",     marketCap: "0.7L Cr",  price: 245000, pe: 62.5, pb: 5.5, divYield: 0.30, beta: 0.85, risk: "med",  logo: "SRF" },
  { symbol: "UPL",        name: "UPL",                       sector: "Chemicals",     marketCap: "0.4L Cr",  price:  55000, pe: 92.5, pb: 2.2, divYield: 1.82, beta: 1.28, risk: "high", logo: "UPL" },

  { symbol: "TATACONSUM", name: "Tata Consumer Products",    sector: "FMCG",          marketCap: "1.0L Cr",  price: 108000, pe: 85.8, pb: 5.1, divYield: 0.80, beta: 0.75, risk: "low",  logo: "TCP" },
  { symbol: "MCDOWELL-N", name: "United Spirits",            sector: "FMCG",          marketCap: "1.0L Cr",  price: 135000, pe: 65.2, pb: 10.2, divYield: 0.25, beta: 0.92, risk: "med",  logo: "USP" },
  { symbol: "VBL",        name: "Varun Beverages",           sector: "FMCG",          marketCap: "2.0L Cr",  price:  62000, pe: 62.5, pb: 14.5, divYield: 0.10, beta: 1.10, risk: "med",  logo: "VBL" },

  { symbol: "PERSISTENT", name: "Persistent Systems",        sector: "IT Services",   marketCap: "0.9L Cr",  price: 580000, pe: 55.2, pb: 14.2, divYield: 0.65, beta: 0.92, risk: "med",  logo: "PER" },
  { symbol: "MPHASIS",    name: "Mphasis",                   sector: "IT Services",   marketCap: "0.6L Cr",  price: 320000, pe: 30.2, pb: 5.4, divYield: 1.85, beta: 0.90, risk: "low",  logo: "MPH" },
  { symbol: "COFORGE",    name: "Coforge",                   sector: "IT Services",   marketCap: "0.6L Cr",  price: 825000, pe: 50.2, pb: 11.8, divYield: 0.95, beta: 0.95, risk: "med",  logo: "COF" },

  { symbol: "IDEA",       name: "Vodafone Idea",             sector: "Telecom",       marketCap: "0.7L Cr",  price:    900, pe: null, pb: -1.2, divYield: 0.00, beta: 1.72, risk: "high", logo: "VOD",
    // Distressed-company flag — stock detail page renders a banner so teens
    // don't learn the wrong lesson ("if I just hold, it recovers").
    warning: "distress",
    warningText: "This company has been financially distressed for years. Included as a cautionary example — a real portfolio should not rely on companies at bankruptcy risk." },
  { symbol: "INDIGO",     name: "InterGlobe Aviation",       sector: "Aviation",      marketCap: "1.7L Cr",  price: 430000, pe: 22.5, pb: 18.5, divYield: 0.00, beta: 1.25, risk: "high", logo: "IND" },

  { symbol: "IRFC",       name: "Indian Railway Finance",    sector: "NBFC",          marketCap: "1.8L Cr",  price:  13800, pe: 25.5, pb: 3.2, divYield: 1.10, beta: 1.35, risk: "med",  logo: "IRF" },
  { symbol: "RECLTD",     name: "REC Limited",               sector: "NBFC",          marketCap: "1.3L Cr",  price:  48500, pe: 8.5, pb: 1.8, divYield: 3.15, beta: 1.30, risk: "med",  logo: "REC" },
  { symbol: "PFC",        name: "Power Finance Corp",        sector: "NBFC",          marketCap: "1.5L Cr",  price:  44500, pe: 7.2, pb: 1.5, divYield: 3.20, beta: 1.28, risk: "med",  logo: "PFC" },

  { symbol: "MOTHERSON",  name: "Samvardhana Motherson",     sector: "Auto",          marketCap: "1.4L Cr",  price:  20000, pe: 35.2, pb: 3.8, divYield: 0.65, beta: 1.32, risk: "med",  logo: "MTH" },
  { symbol: "BHARATFORG", name: "Bharat Forge",              sector: "Auto",          marketCap: "0.6L Cr",  price: 125000, pe: 65.2, pb: 5.5, divYield: 0.65, beta: 1.28, risk: "high", logo: "BHF" },

  { symbol: "BERGEPAINT", name: "Berger Paints",             sector: "Consumer",      marketCap: "0.7L Cr",  price:  58000, pe: 62.5, pb: 14.2, divYield: 0.65, beta: 0.85, risk: "low",  logo: "BRG" },
  { symbol: "PAGEIND",    name: "Page Industries",           sector: "Consumer",      marketCap: "0.4L Cr",  price:4350000, pe: 75.2, pb: 28.5, divYield: 0.55, beta: 0.85, risk: "med",  logo: "PAG" },
  { symbol: "TRENT",      name: "Trent",                     sector: "Retail",        marketCap: "2.5L Cr",  price: 700000, pe: 155, pb: 40.2, divYield: 0.05, beta: 1.00, risk: "high", logo: "TRN" },

  { symbol: "JUBLFOOD",   name: "Jubilant FoodWorks",        sector: "Food",          marketCap: "0.4L Cr",  price:  62000, pe: 105, pb: 14.5, divYield: 0.40, beta: 1.02, risk: "high", logo: "JUB" },
  { symbol: "IEX",        name: "Indian Energy Exchange",    sector: "Exchange",      marketCap: "0.2L Cr",  price:  18500, pe: 48.2, pb: 13.5, divYield: 0.85, beta: 1.08, risk: "med",  logo: "IEX" },

  { symbol: "DIXON",      name: "Dixon Technologies",        sector: "Consumer Elec", marketCap: "0.8L Cr",  price:1350000, pe: 152, pb: 28.5, divYield: 0.05, beta: 1.25, risk: "high", logo: "DXN" },
  { symbol: "POLYCAB",    name: "Polycab India",             sector: "Consumer Elec", marketCap: "0.9L Cr",  price: 615000, pe: 55.2, pb: 10.8, divYield: 0.55, beta: 0.98, risk: "med",  logo: "PLY" },

  { symbol: "TATACOMM",   name: "Tata Communications",       sector: "Telecom",       marketCap: "0.5L Cr",  price: 180000, pe: 92.5, pb: 42.5, divYield: 1.15, beta: 0.92, risk: "med",  logo: "TCO" },
  { symbol: "GMRAIRPORT", name: "GMR Airports",              sector: "Infrastructure",marketCap: "0.9L Cr",  price:   8500, pe: null, pb: -6.5, divYield: 0.00, beta: 1.35, risk: "high", logo: "GMR" },
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
