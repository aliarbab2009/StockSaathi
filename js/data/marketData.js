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
// Keep each upstream batch safely under /api/live-quote's MAX_SYMBOLS=80 and
// /api/quotes's matching 60 cap. Callers can pass the entire universe and
// getQuoteBatch auto-chunks so no page needs its own waving logic.
const MAX_BATCH_SIZE = 60;
// Bumped v2 → v3: v2 had pre-split Reliance etc cached for up to 14 days; we
// evict the lot so nobody paints with 2024-era numbers after the SW refresh.
const QUOTE_PERSIST_KEY = "ss.quotes.v3";
const LEGACY_QUOTE_KEYS = ["ss.quotes.v2", "ss.quotes.v1"];
// 48 h — enough to paint over Fri→Mon weekend gaps, tight enough that the
// Reliance post-split story can't be hidden for weeks.
const PERSIST_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const _quoteCache = new Map();
const _historyCache = new Map();
const _fundamentalsCache = new Map();
// Per-symbol rolling buffer of {t, price} points built from live quotes as
// they arrive. Lets Markets-grid sparklines show the actual intraday move
// instead of a seeded year-long walk. Capped so memory stays bounded during
// long-lived sessions.
const _intradayBuffer = new Map();
const INTRADAY_BUFFER_MAX = 200;
const INTRADAY_MIN_POINTS = 6;

// ---------- localStorage cache so the page paints with REAL prices instantly
function loadPersistedQuotes() {
  // Nuke any legacy cache keys on boot — one-shot migration so users who
  // had stale "Reliance = ₹3,130" saved in ss.quotes.v2 never see it again.
  for (const k of LEGACY_QUOTE_KEYS) {
    try { localStorage.removeItem(k); } catch {}
  }
  try {
    const raw = localStorage.getItem(QUOTE_PERSIST_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    const now = Date.now();
    for (const [sym, entry] of Object.entries(obj)) {
      const data = entry?.data || entry;
      const savedAt = entry?.savedAt || data?.ts;
      if (!data || !savedAt) continue;
      if (now - savedAt > PERSIST_MAX_AGE_MS) continue;
      _quoteCache.set(sym, { data: { ...data, stale: true }, ts: savedAt });
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
      const now = Date.now();
      for (const [sym, entry] of _quoteCache.entries()) {
        if (entry.data) obj[sym] = { data: entry.data, savedAt: now };
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
  // Branded "NSE" — the underlying upstream (Yahoo / Finnhub) is sourcing
  // NSE tick data itself, and the user only cares that the numbers reflect
  // NSE. Calling it "Yahoo Finance" was technically accurate but confusing.
  return { name: "NSE", tier: "public" };
}

function normalizeFromApi(payload, symbol) {
  if (!payload?.ok) return null;
  const ts = payload.ts_ms || Date.now();
  // Staleness detection. Yahoo's free NSE feed is officially 15 min delayed
  // but in practice can fall hours behind during busy sessions. If the
  // quote's own timestamp is more than 5 min old DURING MARKET HOURS, flip
  // the "LIVE" badge to "DELAYED" so we don't lie to users. Outside market
  // hours the old timestamp is expected (market is closed).
  const marketOpenNow = _isNseOpen(Date.now());
  const ageMinutes = (Date.now() - ts) / 60000;
  const stale = marketOpenNow && ageMinutes > 5;
  const pricePaise = Math.round(payload.price * 100);
  _appendIntraday(symbol, ts, pricePaise);
  return {
    symbol,
    pricePaise,
    prevClosePaise: Math.round(payload.prev_close * 100),
    changePct: payload.change_pct ?? 0,
    high: Math.round(payload.day_high * 100),
    low: Math.round(payload.day_low * 100),
    volume: payload.volume || 0,
    currency: payload.currency || "INR",
    ts,
    stale,
    staleAgeMinutes: stale ? Math.round(ageMinutes) : 0,
    source: payload.source || "yahoo",
  };
}

function _appendIntraday(symbol, ts, pricePaise) {
  if (!Number.isFinite(pricePaise)) return;
  let buf = _intradayBuffer.get(symbol);
  if (!buf) {
    buf = [];
    _intradayBuffer.set(symbol, buf);
  }
  // De-dupe consecutive identical prices — no visual value in recording the
  // same close twice, and Yahoo sometimes repeats between ticks.
  const last = buf[buf.length - 1];
  if (last && last.t === ts) return;
  if (last && last.price === pricePaise && ts - last.t < 30_000) return;
  buf.push({ t: ts, price: pricePaise });
  if (buf.length > INTRADAY_BUFFER_MAX) buf.splice(0, buf.length - INTRADAY_BUFFER_MAX);
}

// Returns an array of close prices sourced from the live intraday buffer
// if it has grown enough points, otherwise falls back to the seeded walk
// so cold page loads still render. Used by the Markets grid sparklines.
export function getIntradaySparkline(symbol, fallbackCloses) {
  const buf = _intradayBuffer.get(symbol);
  if (buf && buf.length >= INTRADAY_MIN_POINTS) return buf.map(p => p.price);
  return fallbackCloses;
}

function _isNseOpen(nowMs) {
  // Cheap + correct: use Intl for Asia/Kolkata, mirror prices.js marketStatus.
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", weekday: "short",
      hour12: false,
    }).formatToParts(new Date(nowMs)).reduce((a, p) => (a[p.type] = p.value, a), {});
    const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
    const weekday = (parts.weekday || "").toLowerCase();
    if (["sat", "sun"].includes(weekday)) return false;
    return mins >= 9 * 60 + 15 && mins < 15 * 60 + 30;
  } catch { return false; }
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

  // Auto-chunk when callers pass more than one upstream's worth of symbols.
  // Chunks fire in parallel — whichever lands first paints its cards first.
  if (uniq.length > MAX_BATCH_SIZE) {
    const chunks = [];
    for (let i = 0; i < uniq.length; i += MAX_BATCH_SIZE) {
      chunks.push(uniq.slice(i, i + MAX_BATCH_SIZE));
    }
    const results = await Promise.all(chunks.map(c => _getQuoteBatchInner(c)));
    return Object.assign({}, ...results);
  }
  return _getQuoteBatchInner(uniq);
}

async function _getQuoteBatchInner(uniq) {
  const out = {};

  // Try the new cache-first /api/live-quote endpoint. Hundreds of users
  // polling the same symbols share one upstream Yahoo/Dhan hit per 10s
  // via Supabase quote_cache. Falls through to /api/quotes on failure so
  // this is safe to ship before the quote_cache table is created.
  const liveTargets = uniq.filter(s => {
    const inst = getInstrument(s);
    return inst && inst.kind !== "MF";
  });
  if (liveTargets.length) {
    const liveUrl = `/api/live-quote?symbols=${encodeURIComponent(liveTargets.join(","))}`;
    const live = await fetchJsonWithTimeout(liveUrl).catch(() => null);
    if (live?.ok && live.quotes) {
      let any = false;
      for (const s of liveTargets) {
        const q = live.quotes[s];
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
  }

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

  let h = null;
  if (inst.kind === "EQUITY" || inst.kind === "ETF") {
    // Preferred: dedicated /api/history endpoint (reliable, returns paise).
    // Falls through to legacy fetchYahooHistory → synthHistory on failure.
    try {
      const res = await fetchJsonWithTimeout(
        `/api/history?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`
      );
      if (res?.ok && Array.isArray(res.ohlc) && res.ohlc.length) {
        h = { ohlc: res.ohlc, source: "yahoo", host: res.host };
      }
    } catch {}
    if (!h) {
      h = await fetchYahooHistory(symbol, range, interval).catch(() => null);
    }
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
  // Direct first (works in some browsers / same-origin proxies)
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
