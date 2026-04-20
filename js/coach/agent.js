// =============================================================================
// AGENT — Real LLM with tool-use. Groq-first (free + fast), Anthropic fallback.
//
// Groq Llama 3.3 70B: 500+ tokens/sec, free tier generous enough for 100-user
// pitch demos, OpenAI-compatible tool-use API. User's own key (if set in
// Settings) goes direct to Groq; otherwise we go through /api/chat which the
// backend proxies using GROQ_API_KEY env var.
// =============================================================================

import { getInstrument, STOCKS, MUTUAL_FUNDS } from "../data/universe.js";
import { getQuote } from "../data/marketData.js";
import { getNews } from "../data/news.js";
import { getState, getPortfolioValue } from "../state.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const BACKEND_URL = "/api/chat";
const MODEL = "llama-3.3-70b-versatile";
const MAX_TOKENS = 1024;
const MAX_TOOL_LOOPS = 5;

// -----------------------------------------------------------------------------
// Tools — OpenAI function-calling schema (Groq/OpenAI format)
// -----------------------------------------------------------------------------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_stock_price",
      description:
        "Fetch the current LIVE price for an Indian NSE-listed stock. Returns price, day change %, sector, P/E, day high/low. Use whenever the user asks about ANY specific Indian stock by ticker OR by company name (e.g. 'reliance', 'tcs', 'hdfc bank', 'adani ports').",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "NSE ticker (RELIANCE, TCS, INFY, HDFCBANK) OR a common company name — both work.",
          },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_crypto_price",
      description:
        "Fetch the current LIVE price of a cryptocurrency. Returns INR, USD, 24h change %, market cap. Use when the user asks about ANY crypto — bitcoin, BTC, eth, ethereum, solana, dogecoin, shiba, etc.",
      parameters: {
        type: "object",
        properties: {
          coin: {
            type: "string",
            description: "Coin name or ticker. Accepts: bitcoin, btc, ethereum, eth, solana, sol, dogecoin, doge, etc.",
          },
        },
        required: ["coin"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_stocks",
      description:
        "Search the Indian NSE universe by partial name, sector, or ticker. Use when the user is exploring and doesn't name a specific ticker (e.g. 'show me IT stocks', 'find pharma companies', 'anything related to banking').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free text: company name, sector, or partial ticker." },
          limit: { type: "number", description: "Max results (default 8, max 20)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_market_news",
      description:
        "Fetch the latest Indian market news headlines with sentiment (bullish/bearish/neutral). Use when the user asks about current market mood, sector news, or what's happening today.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max headlines (default 5, max 12)." },
          symbols: {
            type: "array",
            items: { type: "string" },
            description: "Optional — filter to headlines mentioning these NSE tickers.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_user_portfolio",
      description:
        "Get the user's current virtual portfolio: cash, holdings (with live values + P&L), return %. Use for 'my portfolio', 'my holdings', 'how am I doing', 'what do I own'.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// -----------------------------------------------------------------------------
// Tool executors (client-side)
// -----------------------------------------------------------------------------
async function execGetStockPrice(input) {
  const raw = String(input.symbol || "").trim();
  const sym = resolveSymbolFuzzy(raw);
  if (!sym) return { ok: false, error: `No NSE stock matching "${raw}". Try search_stocks.` };
  try {
    const q = await getQuote(sym);
    const inst = getInstrument(sym);
    if (!q || !inst) return { ok: false, error: `No quote for ${sym}.` };
    return {
      ok: true,
      symbol: sym,
      name: inst.name,
      sector: inst.sector,
      price_inr: +(q.pricePaise / 100).toFixed(2),
      prev_close_inr: +(q.prevClosePaise / 100).toFixed(2),
      day_change_pct: +(q.changePct * 100).toFixed(2),
      day_high_inr: +(q.high / 100).toFixed(2),
      day_low_inr: +(q.low / 100).toFixed(2),
      pe_ratio: inst.pe,
      pb_ratio: inst.pb,
      market_cap: inst.marketCap,
      risk_tier: inst.risk,
      data_source: q.source,
      is_live: !q.stale,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function execGetCryptoPrice(input) {
  const coin = String(input.coin || "").toLowerCase().trim();
  const id = resolveCryptoId(coin);
  if (!id) return { ok: false, error: `Unknown coin "${coin}". Try bitcoin, ethereum, solana, dogecoin.` };
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=inr,usd&include_24hr_change=true&include_market_cap=true`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `CoinGecko ${res.status}` };
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
      note: "India: crypto gains taxed at 30% + 1% TDS per trade since 2022.",
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
    .map(x => ({ symbol: x.s.symbol, name: x.s.name, sector: x.s.sector, kind: x.s.kind, risk: x.s.risk }));
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
        headline: n.headline, summary: n.summary, source: n.source,
        sentiment: n.sentiment, hours_ago: n.hoursAgo, url: n.url, symbols: n.symbols,
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
        symbol: sym, name: inst.name, qty: h.qty,
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
    holdings, holdings_count: holdings.length,
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
// Fuzzy symbol resolution — let the LLM be sloppy with names
// -----------------------------------------------------------------------------
const NAME_TO_SYMBOL = (() => {
  const m = {};
  for (const s of STOCKS) {
    m[s.symbol.toLowerCase()] = s.symbol;
    m[s.name.toLowerCase()] = s.symbol;
    m[s.name.toLowerCase().replace(/\s+/g, "")] = s.symbol;
    // First word of name
    const first = s.name.toLowerCase().split(/\s+/)[0];
    if (first.length >= 3 && !m[first]) m[first] = s.symbol;
  }
  Object.assign(m, {
    ril: "RELIANCE", jio: "RELIANCE",
    hdfc: "HDFCBANK", "hdfc bank": "HDFCBANK",
    icici: "ICICIBANK", "icici bank": "ICICIBANK",
    infy: "INFY", infosys: "INFY",
    sbi: "SBIN", "state bank": "SBIN",
    airtel: "BHARTIARTL", bharti: "BHARTIARTL",
    "l&t": "LT", lt: "LT", larsen: "LT",
    hul: "HINDUNILVR", "hindustan unilever": "HINDUNILVR",
    "tata motors": "TMPV", tmpv: "TMPV", tmcv: "TMCV",
    "tata steel": "TATASTEEL",
    nestle: "NESTLEIND",
    "sun pharma": "SUNPHARMA",
    "dr reddy": "DRREDDY",
    "asian paints": "ASIANPAINT",
    hcl: "HCLTECH", hcltech: "HCLTECH",
    "tech mahindra": "TECHM",
    kotak: "KOTAKBANK",
    axis: "AXISBANK",
    "bajaj finance": "BAJFINANCE",
    "bajaj auto": "BAJAJ-AUTO",
    eicher: "EICHERMOT",
    mahindra: "M&M", "m&m": "M&M",
    ultratech: "ULTRACEMCO",
    coal: "COALINDIA", "coal india": "COALINDIA",
    adani: "ADANIENT", "adani ports": "ADANIPORTS",
  });
  return m;
})();

function resolveSymbolFuzzy(input) {
  const s = String(input || "").toLowerCase().trim();
  if (!s) return null;
  const upper = input.toUpperCase().trim();
  if (getInstrument(upper)) return upper;
  if (NAME_TO_SYMBOL[s]) return NAME_TO_SYMBOL[s];
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
  near: "near", tia: "celestia",
};
function resolveCryptoId(q) {
  const clean = String(q).toLowerCase().trim().replace(/[^a-z0-9-]/g, "");
  if (CRYPTO_IDS[clean]) return CRYPTO_IDS[clean];
  if (clean.length >= 3) return clean;
  return null;
}

// -----------------------------------------------------------------------------
// Transport — client-direct OR via backend proxy
// -----------------------------------------------------------------------------
async function callLLM({ apiKey, system, messages, tools }) {
  // Convert chat history (role/content string) to OpenAI format
  const openaiMessages = [
    { role: "system", content: system },
    ...messages,
  ];
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0.5,
    messages: openaiMessages,
    tools,
    tool_choice: "auto",
  };

  // If user has their own Groq key → direct call (fastest path)
  if (apiKey) {
    try {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn("Groq direct HTTP", res.status);
        return null;
      }
      return await res.json();
    } catch (e) {
      console.warn("Groq direct failed:", e);
      return null;
    }
  }

  // Otherwise go through our backend proxy
  try {
    const res = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("Backend /api/chat", res.status, txt);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn("Backend /api/chat failed:", e);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Main agent loop (OpenAI-style tool_calls)
// -----------------------------------------------------------------------------
export async function runAgent({ apiKey, system, messages, onStep }) {
  let loops = 0;
  const conv = messages.map(m => ({ ...m }));

  while (loops < MAX_TOOL_LOOPS) {
    loops++;
    const resp = await callLLM({ apiKey, system, messages: conv, tools: TOOLS });
    if (!resp) {
      console.warn("LLM unreachable (attempt", loops, ")");
      return null;
    }
    if (resp.error) {
      console.warn("LLM error:", JSON.stringify(resp.error).slice(0, 200));
      return null;
    }
    const choice = resp.choices?.[0];
    if (!choice) {
      console.warn("LLM empty choices");
      return null;
    }
    const msg = choice.message || {};

    // Tool-use branch: Groq/OpenAI format has msg.tool_calls array
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const wantsTools = toolCalls.length > 0 &&
      (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call" || !msg.content);

    if (wantsTools) {
      onStep?.({ stepIndex: loops, action: "tool_calls", tools: toolCalls.map(tc => tc.function?.name) });

      // Append assistant tool-call turn as-is
      conv.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: toolCalls,
      });

      // Execute tools in parallel, collect results
      const results = await Promise.all(toolCalls.map(async (tc) => {
        const name = tc.function?.name || "";
        let args = {};
        const rawArgs = tc.function?.arguments ?? "{}";
        try {
          args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : (rawArgs || {});
        } catch (e) {
          args = {};
          console.warn("tool arg parse fail:", rawArgs);
        }
        const executor = EXECUTORS[name];
        let result;
        if (!executor) {
          result = { ok: false, error: `Unknown tool: ${name}. Available: ${Object.keys(EXECUTORS).join(", ")}` };
        } else {
          try { result = await executor(args); }
          catch (e) { result = { ok: false, error: String(e?.message || e) }; }
        }
        return {
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result).slice(0, 4000),   // cap large payloads
        };
      }));

      conv.push(...results);
      continue;
    }

    // Final text response — return even if empty so caller can template-fallback
    const text = (msg.content || "").trim();
    return text || null;
  }

  console.warn("Agent: hit MAX_TOOL_LOOPS");
  return null;
}

export { TOOLS };
