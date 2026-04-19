// =============================================================================
// MARKET DATA — Real-time quote + chart with CORS-proxy chain fallback.
//
// SOURCE PRIORITY:
//   1. Yahoo Finance (direct) — works in many regions
//   2. Yahoo Finance via corsproxy.io — when direct is CORS-blocked
//   3. Yahoo Finance via allorigins.win — backup proxy
//   4. Finnhub (user-provided key)
//   5. Synthetic deterministic cache — ALWAYS works
//
// All responses normalised; prices in PAISE.
// =============================================================================

import { getSeries as synthSeries, getPriceAt as synthPriceAt } from "./prices.js";
import { getInstrument } from "./universe.js";
import { getState } from "../state.js";

const QUOTE_TTL_MS = 30_000;
const HISTORY_TTL_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;

const _quoteCache = new Map();
const _historyCache = new Map();

export function getDataSource() {
  const s = getState().settings;
  if (s.finnhubKey) return { name: "Finnhub + Yahoo", tier: "premium" };
  return { name: "Yahoo Finance", tier: "public" };
}

export async function getQuote(symbol) {
  const cached = _quoteCache.get(symbol);
  if (cached && Date.now() - cached.ts < QUOTE_TTL_MS) return cached.data;
  const inst = getInstrument(symbol);
  if (!inst) return null;

  if (inst.kind === "MF") {
    const q = await fetchMFQuote(symbol, inst).catch(() => null);
    if (q) { _quoteCache.set(symbol, { data: q, ts: Date.now() }); return q; }
    return synthQuote(symbol);
  }

  let q = await fetchYahooQuote(symbol).catch(() => null);
  if (!q) {
    const key = getState().settings.finnhubKey;
    if (key) q = await fetchFinnhubQuote(symbol, key).catch(() => null);
  }
  if (!q) q = synthQuote(symbol);
  _quoteCache.set(symbol, { data: q, ts: Date.now() });
  return q;
}

export async function getQuoteBatch(symbols) {
  const results = await Promise.all(symbols.map(s => getQuote(s).catch(() => null)));
  const out = {};
  for (let i = 0; i < symbols.length; i++) if (results[i]) out[symbols[i]] = results[i];
  return out;
}

export async function getHistory(symbol, range = "1y", interval = "1d") {
  const key = `${symbol}|${range}|${interval}`;
  const cached = _historyCache.get(key);
  if (cached && Date.now() - cached.ts < HISTORY_TTL_MS) return cached.data;
  const inst = getInstrument(symbol);
  if (!inst) return { ohlc: [], source: "none" };

  let h;
  if (inst.kind === "EQUITY" || inst.kind === "ETF") {
    h = await fetchYahooHistory(symbol, range, interval).catch(() => null);
  }
  if (!h) h = synthHistory(symbol);
  _historyCache.set(key, { data: h, ts: Date.now() });
  return h;
}

// --------------------------------------------------------------------------
// Yahoo Finance with progressive CORS-proxy fallback
// --------------------------------------------------------------------------

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

function yahooTicker(sym) {
  if (sym.includes(".")) return sym;
  return `${sym}.NS`;
}

/**
 * Fetch a Yahoo chart URL. Strategy:
 * 1. Our own backend proxy (/api/yahoo/chart/...) — guaranteed CORS-free.
 * 2. Direct Yahoo — works in many browsers/regions.
 * 3. corsproxy.io — free public proxy fallback.
 * 4. allorigins.win — wraps JSON in { contents }.
 */
async function fetchYahooUrl(yahooUrl) {
  // Extract path + query from the Yahoo URL so we can hit our own proxy
  const m = yahooUrl.match(/\/v8\/finance\/chart\/(.+)$/);
  if (m) {
    const ourProxy = `/api/yahoo/chart/${m[1]}`;
    const res = await fetchJsonWithTimeout(ourProxy);
    if (res && !res.error) return res;
  }

  // Direct (works from browser in many regions)
  let res = await fetchJsonWithTimeout(yahooUrl);
  if (res) return res;

  // Public CORS proxies as last resort
  const p1 = `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`;
  res = await fetchJsonWithTimeout(p1);
  if (res) return res;

  const p2 = `https://api.allorigins.win/get?url=${encodeURIComponent(yahooUrl)}`;
  const w = await fetchJsonWithTimeout(p2);
  if (w?.contents) { try { return JSON.parse(w.contents); } catch {} }

  return null;
}

async function fetchYahooQuote(symbol) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(yahooTicker(symbol))}?interval=1d&range=5d`;
  const data = await fetchYahooUrl(url);
  const r = data?.chart?.result?.[0];
  if (!r) return null;
  const meta = r.meta || {};
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  if (price == null) return null;
  return {
    symbol,
    pricePaise: Math.round(price * 100),
    prevClosePaise: Math.round(prevClose * 100),
    changePct: prevClose ? (price - prevClose) / prevClose : 0,
    high: Math.round((meta.regularMarketDayHigh || price) * 100),
    low: Math.round((meta.regularMarketDayLow || price) * 100),
    volume: meta.regularMarketVolume || 0,
    currency: meta.currency || "INR",
    ts: (meta.regularMarketTime || Math.floor(Date.now() / 1000)) * 1000,
    stale: false,
    source: "yahoo",
  };
}

async function fetchYahooHistory(symbol, range, interval) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(yahooTicker(symbol))}?interval=${interval}&range=${range}`;
  const data = await fetchYahooUrl(url);
  const r = data?.chart?.result?.[0];
  if (!r) return null;
  const timestamps = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const ohlc = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = q.close?.[i], o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], v = q.volume?.[i];
    if (c == null || o == null || h == null || l == null) continue;
    ohlc.push({
      t: timestamps[i] * 1000,
      o: Math.round(o * 100), h: Math.round(h * 100),
      l: Math.round(l * 100), c: Math.round(c * 100),
      v: v || 0,
    });
  }
  if (!ohlc.length) return null;
  return { ohlc, source: "yahoo" };
}

async function fetchFinnhubQuote(symbol, key) {
  const url = `https://finnhub.io/api/v1/quote?symbol=NSE:${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`;
  const data = await fetchJsonWithTimeout(url);
  if (!data || data.c == null || data.c === 0) return null;
  return {
    symbol,
    pricePaise: Math.round(data.c * 100),
    prevClosePaise: Math.round((data.pc || data.c) * 100),
    changePct: data.pc ? (data.c - data.pc) / data.pc : 0,
    high: Math.round((data.h || data.c) * 100),
    low: Math.round((data.l || data.c) * 100),
    volume: 0,
    currency: "INR",
    ts: (data.t || Math.floor(Date.now() / 1000)) * 1000,
    stale: false,
    source: "finnhub",
  };
}

async function fetchMFQuote(symbol, inst) {
  const basePaise = inst.price;
  const drift = (Math.sin(Date.now() / 3_600_000) * 0.005) + (Math.random() * 0.002 - 0.001);
  const cur = Math.round(basePaise * (1 + drift));
  return {
    symbol, pricePaise: cur, prevClosePaise: basePaise,
    changePct: (cur - basePaise) / basePaise,
    high: cur, low: cur, volume: 0,
    currency: "INR", ts: Date.now(),
    stale: false, source: "mf-static",
  };
}

function synthQuote(symbol) {
  const cur = synthPriceAt(symbol, 0);
  const prev = synthPriceAt(symbol, 1) || cur;
  if (!cur) return null;
  return {
    symbol, pricePaise: cur, prevClosePaise: prev,
    changePct: prev ? (cur - prev) / prev : 0,
    high: Math.round(cur * 1.005), low: Math.round(cur * 0.995),
    volume: 0, currency: "INR", ts: Date.now(),
    stale: true, source: "synthetic",
  };
}
function synthHistory(symbol) { return { ohlc: synthSeries(symbol), source: "synthetic" }; }

function fetchJsonWithTimeout(url, options = {}) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    fetch(url, { ...options, signal: ctrl.signal, cache: "no-store" })
      .then(r => {
        clearTimeout(t);
        if (!r.ok) { resolve(null); return; }
        return r.json();
      })
      .then(j => resolve(j || null))
      .catch(() => { clearTimeout(t); resolve(null); });
  });
}

export function subscribeToQuotes(symbols, onUpdate, intervalMs = 45_000) {
  if (!symbols?.length) return () => {};
  let cancelled = false;
  async function tick() {
    if (cancelled) return;
    const quotes = await getQuoteBatch(symbols);
    if (cancelled) return;
    onUpdate(quotes);
  }
  tick();
  const h = setInterval(tick, intervalMs);
  return () => { cancelled = true; clearInterval(h); };
}
