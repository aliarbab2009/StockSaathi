// =============================================================================
// MARKET DATA — brute-force reliable live quotes.
//
// Priority:
//   1. /api/quote?symbol=X           — normalized single-symbol endpoint
//   2. /api/quotes?symbols=A,B,C     — parallel batch endpoint (for lists)
//   3. Direct Yahoo (many browsers)  — if browser allows CORS
//   4. Public CORS proxies           — last resort
//   5. Synthetic baseline            — never fails; clearly marked "stale"
//
// All prices paise. TTL 8s (tight for live feel). Batch uses all 50+ symbols
// in parallel server-side for the Markets page.
// =============================================================================

import { getSeries as synthSeries, getPriceAt as synthPriceAt } from "./prices.js";
import { getInstrument } from "./universe.js";
import { getState } from "../state.js";

const QUOTE_TTL_MS = 8_000;
const HISTORY_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const QUOTE_PERSIST_KEY = "ss.quotes.v1";
const PERSIST_MAX_AGE_MS = 6 * 60 * 60 * 1000;   // 6h max for stale-on-load

const _quoteCache = new Map();
const _historyCache = new Map();
const _fundamentalsCache = new Map();

// ---------- localStorage cache so the page paints with REAL prices instantly
function loadPersistedQuotes() {
  try {
    const raw = localStorage.getItem(QUOTE_PERSIST_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    const now = Date.now();
    for (const [sym, data] of Object.entries(obj)) {
      if (!data?.ts || now - data.ts > PERSIST_MAX_AGE_MS) continue;
      // Mark as stale on load so UI can show "Updated Xs ago"
      _quoteCache.set(sym, { data: { ...data, stale: true }, ts: data.ts });
    }
  } catch {}
}
loadPersistedQuotes();

let _persistTimer = null;
function persistSoon() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      const obj = {};
      for (const [sym, entry] of _quoteCache.entries()) {
        if (entry.data) obj[sym] = entry.data;
      }
      localStorage.setItem(QUOTE_PERSIST_KEY, JSON.stringify(obj));
    } catch {}
  }, 800);
}

// Synchronous read of whatever is already in memory (incl. localStorage-loaded
// stale entries). Used by pages to prefill their first render instantly.
export function getCachedQuotes(symbols) {
  const out = {};
  if (!symbols) return out;
  for (const s of symbols) {
    const c = _quoteCache.get(s);
    if (c?.data) out[s] = c.data;
  }
  return out;
}

export function getDataSource() {
  const s = getState().settings;
  if (s.finnhubKey) return { name: "Finnhub + Yahoo", tier: "premium" };
  return { name: "Yahoo Finance", tier: "public" };
}

function normalizeFromApi(payload, symbol) {
  if (!payload?.ok) return null;
  return {
    symbol,
    pricePaise: Math.round(payload.price * 100),
    prevClosePaise: Math.round(payload.prev_close * 100),
    changePct: payload.change_pct ?? 0,
    high: Math.round(payload.day_high * 100),
    low: Math.round(payload.day_low * 100),
    volume: payload.volume || 0,
    currency: payload.currency || "INR",
    ts: payload.ts_ms || Date.now(),
    stale: false,
    source: payload.source || "yahoo",
  };
}

// ---------- Public API -----------------------------------------------------

export async function getQuote(symbol) {
  const cached = _quoteCache.get(symbol);
  if (cached && Date.now() - cached.ts < QUOTE_TTL_MS) return cached.data;

  const inst = getInstrument(symbol);
  if (!inst) return null;

  // MFs have no real-time feed — synthetic
  if (inst.kind === "MF") {
    const q = synthMFQuote(symbol, inst);
    _quoteCache.set(symbol, { data: q, ts: Date.now() });
    return q;
  }

  // 1. New normalized single endpoint
  const apiRes = await fetchJsonWithTimeout(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
  const apiQuote = normalizeFromApi(apiRes, symbol);
  if (apiQuote) {
    _quoteCache.set(symbol, { data: apiQuote, ts: Date.now() });
    persistSoon();
    return apiQuote;
  }

  // 2. Legacy path through /api/yahoo/chart
  const fallback = await fetchYahooQuote(symbol).catch(() => null);
  if (fallback) {
    _quoteCache.set(symbol, { data: fallback, ts: Date.now() });
    persistSoon();
    return fallback;
  }

  // 3. Synthetic last resort — marked stale so UI can flag it
  const synth = synthQuote(symbol);
  _quoteCache.set(symbol, { data: synth, ts: Date.now() });
  return synth;
}

export async function getQuoteBatch(symbols) {
  if (!symbols?.length) return {};
  const uniq = [...new Set(symbols)];
  const out = {};
  const need = [];

  // Serve from cache first
  for (const s of uniq) {
    const c = _quoteCache.get(s);
    if (c && Date.now() - c.ts < QUOTE_TTL_MS) out[s] = c.data;
    else need.push(s);
  }
  if (!need.length) return out;

  // Try batch endpoint — fetches all missing symbols in parallel server-side
  const batchUrl = `/api/quotes?symbols=${encodeURIComponent(need.join(","))}`;
  const batch = await fetchJsonWithTimeout(batchUrl);
  if (batch?.ok && batch.quotes) {
    let any = false;
    for (const s of need) {
      const q = batch.quotes[s];
      if (q) {
        const norm = normalizeFromApi({ ok: true, ...q }, s);
        if (norm) {
          out[s] = norm;
          _quoteCache.set(s, { data: norm, ts: Date.now() });
          any = true;
        }
      }
    }
    if (any) persistSoon();
  }

  // Fill any remaining misses one by one (usually empty)
  const missing = need.filter(s => !out[s]);
  if (missing.length) {
    const results = await Promise.all(missing.map(s => getQuote(s).catch(() => null)));
    for (let i = 0; i < missing.length; i++) {
      if (results[i]) out[missing[i]] = results[i];
    }
  }
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

// ---------- Live polling ---------------------------------------------------

export function subscribeToQuotes(symbols, onUpdate, intervalMs = 10_000) {
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

export function quoteAge(quote) {
  if (!quote?.ts) return null;
  return Date.now() - quote.ts;
}

// =============================================================================
// FUNDAMENTALS — real values via /api/fundamentals (Yahoo v7/quote backed)
// Cached 5 min in memory. Fundamentals barely change intraday.
// =============================================================================
const FUND_TTL_MS = 5 * 60_000;

export async function getFundamentals(symbol) {
  const cached = _fundamentalsCache.get(symbol);
  if (cached && Date.now() - cached.ts < FUND_TTL_MS) return cached.data;
  const res = await fetchJsonWithTimeout(`/api/fundamentals?symbol=${encodeURIComponent(symbol)}`);
  if (res?.ok) {
    _fundamentalsCache.set(symbol, { data: res, ts: Date.now() });
    return res;
  }
  return null;
}

// ---------- Legacy Yahoo proxy chain (kept as fallback) --------------------

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
function yahooTicker(sym) { return sym.includes(".") ? sym : `${sym}.NS`; }

async function fetchYahooUrl(yahooUrl) {
  // Try legacy /api/yahoo/chart route
  const m = yahooUrl.match(/\/v8\/finance\/chart\/(.+)$/);
  if (m) {
    const ourProxy = `/api/yahoo/chart/${m[1]}`;
    const res = await fetchJsonWithTimeout(ourProxy);
    if (res && !res.error) return res;
  }
  // Direct
  let res = await fetchJsonWithTimeout(yahooUrl);
  if (res) return res;
  // Public proxies
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

function synthMFQuote(symbol, inst) {
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
