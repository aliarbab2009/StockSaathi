// =============================================================================
// AGENT — Real LLM with tool-use.
//
// Claude parses every message, infers intent, and calls tools when it needs
// real data (live prices, news, portfolio). No regex shortcuts. No template
// first-pass. The LLM is the primary — templates are the last-resort fallback.
//
// Flow:
//   user message → Claude → (if tool_use) → execute tool → Claude → … → text
// =============================================================================

import { getInstrument, STOCKS, MUTUAL_FUNDS } from "../data/universe.js";
import { getQuote } from "../data/marketData.js";
import { getNews } from "../data/news.js";
import { getState, getPortfolioValue } from "../state.js";
import { formatRupees } from "../money.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const BACKEND_URL = "/api/chat";
const MODEL = "claude-sonnet-4-5-20250929";
const MAX_TOKENS = 1024;
const MAX_TOOL_LOOPS = 5;   // hard cap on tool-use iterations per turn

// -----------------------------------------------------------------------------
// Tool definitions (shown to the LLM)
// -----------------------------------------------------------------------------
const TOOLS = [
  {
    name: "get_stock_price",
    description:
      "Fetch the current live price for an Indian NSE-listed stock. Returns price, day change %, sector, P/E, and data source. Use this whenever the user asks about ANY specific Indian stock (by ticker OR by company name like 'reliance', 'tcs', 'hdfc bank').",
    input_schema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "NSE ticker (e.g. RELIANCE, TCS, INFY, HDFCBANK, TATAMOTORS) OR a common company name — both work.",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_crypto_price",
    description:
      "Fetch the current live price of a cryptocurrency in INR and USD. Use when the user asks about ANY crypto (bitcoin, BTC, eth, ethereum, solana, dogecoin, etc). Returns INR, USD, 24h change %, market cap.",
    input_schema: {
      type: "object",
      properties: {
        coin: {
          type: "string",
          description: "Coin name or ticker: 'bitcoin' | 'btc' | 'ethereum' | 'eth' | 'solana' | 'sol' | 'dogecoin' | 'doge' etc.",
        },
      },
      required: ["coin"],
    },
  },
  {
    name: "search_stocks",
    description:
      "Search the Indian NSE universe by partial name, sector, or ticker. Use when the user is exploring (e.g. 'show me IT stocks', 'what pharma companies') and doesn't name a specific ticker.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text: company name, sector, or partial ticker." },
        limit: { type: "number", description: "Max results (default 8)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_market_news",
    description:
      "Fetch the latest Indian market news headlines with sentiment tags (bullish/bearish/neutral). Use when the user asks about current market mood, sector news, or recent events affecting stocks.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max headlines to return (default 5, max 12)." },
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Optional — filter to headlines mentioning these NSE tickers.",
        },
      },
    },
  },
  {
    name: "get_user_portfolio",
    description:
      "Get the current user's virtual portfolio: cash balance, holdings (with avg cost + current value + P&L), recent trades, and overall return %. Use when the user asks about 'my portfolio', 'my holdings', 'how am I doing', etc.",
    input_schema: { type: "object", properties: {} },
  },
];

// -----------------------------------------------------------------------------
// Tool executors (client-side)
// -----------------------------------------------------------------------------
async function execGetStockPrice(input) {
  const raw = String(input.symbol || "").trim();
  const sym = resolveSymbolFuzzy(raw);
  if (!sym) return { ok: false, error: `Could not find an NSE stock matching "${raw}". Use search_stocks to find it.` };
  try {
    const q = await getQuote(sym);
    const inst = getInstrument(sym);
    if (!q || !inst) return { ok: false, error: `No quote available for ${sym}.` };
    return {
      ok: true,
      symbol: sym,
      name: inst.name,
      sector: inst.sector,
      price_inr: +(q.pricePaise / 100).toFixed(2),
      prev_close_inr: +(q.prevClosePaise / 100).toFixed(2),
      day_change_pct: +(q.changePct * 100).toFixed(2),
      day_high: +(q.high / 100).toFixed(2),
      day_low: +(q.low / 100).toFixed(2),
      pe_ratio: inst.pe,
      pb_ratio: inst.pb,
      dividend_yield: inst.divYield,
      market_cap: inst.marketCap,
      risk_tier: inst.risk,
      beta: inst.beta,
      data_source: q.source,
      is_stale: q.stale,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function execGetCryptoPrice(input) {
  const coin = String(input.coin || "").toLowerCase().trim();
  const id = resolveCryptoId(coin);
  if (!id) return { ok: false, error: `Unknown coin "${coin}". Try: bitcoin, ethereum, solana, dogecoin, etc.` };
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=inr,usd&include_24hr_change=true&include_market_cap=true`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `CoinGecko returned ${res.status}` };
    const data = await res.json();
    const p = data[id];
    if (!p) return { ok: false, error: `No data for ${id}` };
    return {
      ok: true,
      coin: id,
      price_inr: p.inr,
      price_usd: p.usd,
      change_24h_pct: p.inr_24h_change != null ? +p.inr_24h_change.toFixed(2) : null,
      market_cap_inr: p.inr_market_cap,
      note: "In India: crypto gains taxed at 30% + 1% TDS per trade since 2022.",
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function execSearchStocks(input) {
  const q = String(input.query || "").toLowerCase().trim();
  const limit = Math.min(input.limit || 8, 20);
  if (!q) return { ok: false, error: "Empty query." };
  const all = [...STOCKS, ...MUTUAL_FUNDS];
  const matches = all
    .map(s => {
      let score = 0;
      const name = s.name.toLowerCase();
      const sector = (s.sector || "").toLowerCase();
      const sym = s.symbol.toLowerCase();
      if (sym === q) score += 100;
      if (sym.includes(q)) score += 50;
      if (name.includes(q)) score += 30;
      if (sector.includes(q)) score += 20;
      if (name.split(/\s+/).some(w => w === q)) score += 15;
      return { s, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => ({
      symbol: x.s.symbol,
      name: x.s.name,
      sector: x.s.sector,
      kind: x.s.kind,
      risk: x.s.risk,
    }));
  return { ok: true, query: q, results: matches, count: matches.length };
}

async function execGetMarketNews(input) {
  try {
    const items = await getNews({
      limit: Math.min(input.limit || 5, 12),
      filterSymbols: input.symbols?.length ? input.symbols.map(s => s.toUpperCase()) : null,
    });
    return {
      ok: true,
      headlines: items.map(n => ({
        headline: n.headline,
        summary: n.summary,
        source: n.source,
        sentiment: n.sentiment,
        hours_ago: n.hoursAgo,
        url: n.url,
        symbols: n.symbols,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function execGetUserPortfolio() {
  const state = getState();
  if (!state.isAuthed) return { ok: false, error: "User not logged in." };
  const holdings = [];
  for (const [sym, h] of Object.entries(state.holdings || {})) {
    const inst = getInstrument(sym);
    if (!inst) continue;
    try {
      const q = await getQuote(sym);
      const curPx = q ? q.pricePaise : h.avgCostPaise;
      holdings.push({
        symbol: sym,
        name: inst.name,
        qty: h.qty,
        avg_cost_inr: +(h.avgCostPaise / 100).toFixed(2),
        current_price_inr: +(curPx / 100).toFixed(2),
        value_inr: +((h.qty * curPx) / 100).toFixed(2),
        pl_pct: +(((curPx - h.avgCostPaise) / h.avgCostPaise) * 100).toFixed(2),
      });
    } catch {}
  }
  const total = getPortfolioValue(state);
  const start = state.portfolio.startingCashPaise;
  return {
    ok: true,
    cash_inr: +(state.portfolio.cashPaise / 100).toFixed(2),
    total_value_inr: +(total / 100).toFixed(2),
    return_pct: +(((total - start) / start) * 100).toFixed(2),
    holdings,
    holdings_count: holdings.length,
    trade_count: state.transactions.length,
  };
}

const EXECUTORS = {
  get_stock_price: execGetStockPrice,
  get_crypto_price: execGetCryptoPrice,
  search_stocks: execSearchStocks,
  get_market_news: execGetMarketNews,
  get_user_portfolio: execGetUserPortfolio,
};

// -----------------------------------------------------------------------------
// Helpers: fuzzy ticker resolver + crypto ID map (small, focused)
// -----------------------------------------------------------------------------
const NAME_TO_SYMBOL = (() => {
  const m = {};
  for (const s of STOCKS) {
    m[s.symbol.toLowerCase()] = s.symbol;
    m[s.name.toLowerCase()] = s.symbol;
    m[s.name.toLowerCase().replace(/\s+/g, "")] = s.symbol;
  }
  // Common short names
  Object.assign(m, {
    ril: "RELIANCE", jio: "RELIANCE", reliance: "RELIANCE",
    "hdfc bank": "HDFCBANK", hdfc: "HDFCBANK",
    "icici bank": "ICICIBANK", icici: "ICICIBANK",
    infy: "INFY", infosys: "INFY",
    "tata motors": "TATAMOTORS",
    "tata steel": "TATASTEEL",
    "jsw steel": "JSWSTEEL",
    sbi: "SBIN", "state bank": "SBIN",
    airtel: "BHARTIARTL", bharti: "BHARTIARTL",
    "l&t": "LT", "lt": "LT", larsen: "LT",
    hul: "HINDUNILVR", "hindustan unilever": "HINDUNILVR",
    maruti: "MARUTI",
    itc: "ITC",
    tcs: "TCS",
    nestle: "NESTLEIND",
    britannia: "BRITANNIA",
    "sun pharma": "SUNPHARMA",
    "dr reddy": "DRREDDY",
    "asian paints": "ASIANPAINT",
    wipro: "WIPRO",
    hcl: "HCLTECH", hcltech: "HCLTECH",
    "tech mahindra": "TECHM",
    kotak: "KOTAKBANK",
    axis: "AXISBANK",
    "bajaj finance": "BAJFINANCE",
    "bajaj auto": "BAJAJ-AUTO",
    eicher: "EICHERMOT",
    mahindra: "M&M", "m&m": "M&M",
    ultratech: "ULTRACEMCO",
    grasim: "GRASIM",
    "coal india": "COALINDIA", coal: "COALINDIA",
    ongc: "ONGC",
    ntpc: "NTPC",
    powergrid: "POWERGRID",
    titan: "TITAN",
    irctc: "IRCTC",
    zomato: "ZOMATO",
    paytm: "PAYTM",
    nykaa: "NYKAA",
    dmart: "DMART",
    adani: "ADANIENT",
    "adani ports": "ADANIPORTS",
  });
  return m;
})();

function resolveSymbolFuzzy(input) {
  const s = String(input || "").toLowerCase().trim();
  if (!s) return null;
  const upper = input.toUpperCase().trim();
  if (getInstrument(upper)) return upper;
  if (NAME_TO_SYMBOL[s]) return NAME_TO_SYMBOL[s];
  // Strip suffixes / common noise
  const cleaned = s.replace(/\s+(ltd|limited|india|indian|corp|corporation|co)\b/g, "").trim();
  if (NAME_TO_SYMBOL[cleaned]) return NAME_TO_SYMBOL[cleaned];
  return null;
}

const CRYPTO_IDS = {
  btc: "bitcoin", bitcoin: "bitcoin",
  eth: "ethereum", ethereum: "ethereum", ether: "ethereum",
  bnb: "binancecoin", binance: "binancecoin",
  sol: "solana", solana: "solana",
  xrp: "ripple", ripple: "ripple",
  ada: "cardano", cardano: "cardano",
  doge: "dogecoin", dogecoin: "dogecoin",
  shib: "shiba-inu", shiba: "shiba-inu",
  dot: "polkadot", polkadot: "polkadot",
  matic: "matic-network", polygon: "matic-network",
  avax: "avalanche-2", avalanche: "avalanche-2",
  ltc: "litecoin", litecoin: "litecoin",
  trx: "tron", tron: "tron",
  link: "chainlink", chainlink: "chainlink",
  atom: "cosmos", cosmos: "cosmos",
  uni: "uniswap", uniswap: "uniswap",
  near: "near",
  tia: "celestia",
};
function resolveCryptoId(q) {
  const clean = String(q).toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
  if (CRYPTO_IDS[clean]) return CRYPTO_IDS[clean];
  // CoinGecko IDs are usually slug-like; accept direct slugs too
  if (clean.length >= 3) return clean;
  return null;
}

// -----------------------------------------------------------------------------
// Anthropic call (direct OR via our backend proxy)
// -----------------------------------------------------------------------------
async function callAnthropic({ apiKey, system, messages, tools }) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0.5,
    system,
    tools,
    messages,
  };

  // If no client key, try the backend proxy (which uses the server's env key)
  if (!apiKey) {
    try {
      const res = await fetch(BACKEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // Direct from browser with user's key
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn("Anthropic HTTP", res.status, await res.text().catch(() => ""));
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn("Anthropic fetch failed:", e);
    return null;
  }
}

// -----------------------------------------------------------------------------
// The main loop — REAL tool-use agent
// -----------------------------------------------------------------------------
/**
 * Run the agent on a conversation.
 * @param {Object} args
 * @param {string|null} args.apiKey  - user's Anthropic key (null → use backend)
 * @param {string} args.system        - system prompt
 * @param {Array} args.messages       - [{role: "user"|"assistant", content: string|array}]
 * @param {Function} [args.onStep]    - optional callback per iteration ({stepIndex, action, tools})
 * @returns {Promise<string|null>}    - final text, or null on failure
 */
export async function runAgent({ apiKey, system, messages, onStep }) {
  let loops = 0;
  // Defensive copy so we don't mutate caller's history
  const conv = messages.map(m => ({ ...m }));

  while (loops < MAX_TOOL_LOOPS) {
    loops++;
    const resp = await callAnthropic({ apiKey, system, messages: conv, tools: TOOLS });
    if (!resp) return null;
    if (resp.error) {
      console.warn("Anthropic error:", resp.error);
      return null;
    }
    const content = resp.content || [];
    const stopReason = resp.stop_reason;

    // If LLM wants to use tools, execute them and continue
    if (stopReason === "tool_use") {
      const toolUses = content.filter(c => c.type === "tool_use");
      if (!toolUses.length) break;

      onStep?.({ stepIndex: loops, action: "tool_use", tools: toolUses.map(t => t.name) });

      const toolResults = await Promise.all(toolUses.map(async tu => {
        const executor = EXECUTORS[tu.name];
        let result;
        if (!executor) {
          result = { ok: false, error: `Unknown tool: ${tu.name}` };
        } else {
          try { result = await executor(tu.input || {}); }
          catch (e) { result = { ok: false, error: String(e?.message || e) }; }
        }
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        };
      }));

      // Add the assistant turn (with tool_use blocks) + user turn (with tool_result blocks)
      conv.push({ role: "assistant", content });
      conv.push({ role: "user", content: toolResults });
      continue;
    }

    // end_turn — extract final text
    const text = content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("\n")
      .trim();
    return text || null;
  }

  console.warn("Agent hit max tool loops");
  return null;
}

// -----------------------------------------------------------------------------
// Export the tool list so other modules can inspect (e.g. for UI hints)
// -----------------------------------------------------------------------------
export { TOOLS };
