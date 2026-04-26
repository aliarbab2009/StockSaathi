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
// 7s, not 10s: the live-quote poll fires every 10s, so a 10s timeout would
// allow a stuck request to still be in flight when its successor launches —
// they pile up and share connections. 7s leaves a 3s gap so each tick is
// firmly resolved or aborted before the next one fires.
const FETCH_TIMEOUT_MS = 7_000;
// Keep each upstream batch safely under /api/live-quote's MAX_SYMBOLS=80 and
// /api/quotes's matching 60 cap. Callers can pass the entire universe and
// getQuoteBatch auto-chunks so no page needs its own waving logic.
const MAX_BATCH_SIZE = 60;
// Cap concurrent in-flight chunks. With 2700 symbols and 60-per-chunk that
// would otherwise fan out to 45 simultaneous fetches via Promise.all,
// saturating Chrome's 6-per-host limit and creating head-of-line blocking.
// 4 keeps the pipeline saturated without thrashing.
const MAX_CONCURRENT_CHUNKS = 4;
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
// Sidecar tracking last-access timestamp for every symbol in _quoteCache.
// persistSoon truncates localStorage to the hottest 200 symbols so the
// 800ms-debounced JSON.stringify doesn't choke at 2700 symbols (~600 KB
// per write blocking the main thread). _touchQuote bumps the timestamp on
// every cache write OR read of a symbol's quote.
const _quoteAccessTs = new Map();
const PERSIST_MAX_SYMBOLS = 200;
function _touchQuote(sym) { _quoteAccessTs.set(sym, Date.now()); }

// Per-symbol rolling buffer of {t, price} points built from live quotes as
// they arrive. Lets Markets-grid sparklines show the actual intraday move
// instead of a seeded year-long walk. Capped so memory stays bounded during
// long-lived sessions. INTRADAY_SYMBOLS_MAX caps distinct symbol keys (LRU
// eviction in _appendIntraday); INTRADAY_BUFFER_MAX caps points per symbol.
const _intradayBuffer = new Map();
const INTRADAY_SYMBOLS_MAX = 200;        // distinct symbols held — LRU evicts beyond
const INTRADAY_BUFFER_MAX = 200;         // points per symbol
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
      // Truncate to the hottest PERSIST_MAX_SYMBOLS by last-access ts.
      // Symbols never touched fall back to ts=0 and sort to the bottom, so
      // they're naturally evicted when the universe is wide. This keeps
      // localStorage writes under ~50 KB regardless of universe size.
      const ranked = [];
      for (const sym of _quoteCache.keys()) {
        ranked.push([sym, _quoteAccessTs.get(sym) || 0]);
      }
      ranked.sort((a, b) => b[1] - a[1]);
      const keep = ranked.slice(0, PERSIST_MAX_SYMBOLS);
      const obj = {};
      const now = Date.now();
      for (const [sym] of keep) {
        const entry = _quoteCache.get(sym);
        if (entry?.data) obj[sym] = { data: entry.data, savedAt: now };
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

// Like getCachedQuotes but ONLY returns quotes that aren't stale. Rules:
// - Market CLOSED: any cached quote is fine (yesterday's close is still
//   the current reference price for display).
// - Market OPEN: the cache entry must be fresher than `maxAgeMs` AND the
//   quote's own upstream-staleness flag must be false (data.stale).
// Pages use this when they'd rather flash a skeleton for a second than
// display a misleading stale price (stock detail, stocks grid cards).
export function getFreshCachedQuote(symbol, maxAgeMs = 30_000) {
  const c = _quoteCache.get(symbol);
  if (!c?.data) return null;
  const marketOpen = _isNseOpen(Date.now());
  if (!marketOpen) return c.data;                  // closed → cache IS truth
  if (Date.now() - c.ts > maxAgeMs) return null;   // fetched too long ago
  if (c.data.stale) return null;                   // upstream feed lagged
  return c.data;
}
export function getFreshCachedQuotes(symbols, maxAgeMs = 30_000) {
  const out = {};
  if (!symbols) return out;
  for (const s of symbols) {
    const q = getFreshCachedQuote(s, maxAgeMs);
    if (q) out[s] = q;
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
  if (buf) {
    // Touch: re-insert moves the symbol to the tail of insertion order so
    // the head is always the least-recently-touched (LRU eviction target).
    _intradayBuffer.delete(symbol);
    _intradayBuffer.set(symbol, buf);
  } else {
    buf = [];
    _intradayBuffer.set(symbol, buf);
    // Evict the least-recently-touched buffer once we exceed the symbol cap.
    // At ~50 KB per filled buffer × 200 cap = ~10 MB resident, vs ~135 MB if
    // 2700 symbols all populated. Caps memory across long-lived sessions.
    if (_intradayBuffer.size > INTRADAY_SYMBOLS_MAX) {
      const oldest = _intradayBuffer.keys().next().value;
      if (oldest !== undefined) _intradayBuffer.delete(oldest);
    }
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

export async function getQuote(symbol, opts = {}) {
  const bustCache = opts.bustCache === true;
  if (!bustCache) {
    const cached = _quoteCache.get(symbol);
    if (cached && Date.now() - cached.ts < QUOTE_TTL_MS) return cached.data;
  }

  const inst = getInstrument(symbol);
  if (!inst) return null;

  // MFs have no real-time feed — synthetic
  if (inst.kind === "MF") {
    const q = synthMFQuote(symbol, inst);
    _quoteCache.set(symbol, { data: q, ts: Date.now() });
    return q;
  }

  // 1. New normalized single endpoint. Append nocache=1 when bustCache
  // is requested so the SERVER also bypasses its own cache (and Vercel
  // edge cache via the no-store header the server adds when it sees
  // nocache=1) — otherwise the server might hand back its own cached
  // value that's still seconds old.
  const qs = bustCache ? `?symbol=${encodeURIComponent(symbol)}&nocache=1&_=${Date.now()}` : `?symbol=${encodeURIComponent(symbol)}`;
  const apiRes = await fetchJsonWithTimeout(`/api/quote${qs}`);
  const apiQuote = normalizeFromApi(apiRes, symbol);
  if (apiQuote) {
    _quoteCache.set(symbol, { data: apiQuote, ts: Date.now() });
    _touchQuote(symbol);
    persistSoon();
    return apiQuote;
  }

  // 2. Legacy path through /api/yahoo/chart
  const fallback = await fetchYahooQuote(symbol).catch(() => null);
  if (fallback) {
    _quoteCache.set(symbol, { data: fallback, ts: Date.now() });
    _touchQuote(symbol);
    persistSoon();
    return fallback;
  }

  // 3. Synthetic last resort — marked stale so UI can flag it
  const synth = synthQuote(symbol);
  _quoteCache.set(symbol, { data: synth, ts: Date.now() });
  _touchQuote(symbol);
  return synth;
}

export async function getQuoteBatch(symbols) {
  if (!symbols?.length) return {};
  const uniq = [...new Set(symbols)];

  // Auto-chunk when callers pass more than one upstream's worth of symbols.
  // Cap concurrency so a 2700-symbol fan-out doesn't burst 45 simultaneous
  // fetch() calls and starve the browser's per-host connection pool. 4 in
  // flight keeps the pipeline saturated without head-of-line blocking.
  if (uniq.length > MAX_BATCH_SIZE) {
    const chunks = [];
    for (let i = 0; i < uniq.length; i += MAX_BATCH_SIZE) {
      chunks.push(uniq.slice(i, i + MAX_BATCH_SIZE));
    }
    const results = await _runWithLimit(chunks, MAX_CONCURRENT_CHUNKS, c => _getQuoteBatchInner(c));
    return Object.assign({}, ...results);
  }
  return _getQuoteBatchInner(uniq);
}

// Tiny p-limit-style runner: starts up to `limit` workers, each pulls the
// next item until exhausted. Preserves input order in the result array.
async function _runWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function pump() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await worker(items[i], i); }
      catch (e) { results[i] = {}; }   // swallow chunk failure, neighbours survive
    }
  }
  const workers = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) workers.push(pump());
  await Promise.all(workers);
  return results;
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
            _touchQuote(s);
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
    if (c && Date.now() - c.ts < QUOTE_TTL_MS) { out[s] = c.data; _touchQuote(s); }
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
          _touchQuote(s);
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

export async function getHistory(symbol, range = "1y", interval = "1d", opts = {}) {
  const key = `${symbol}|${range}|${interval}`;
  // Caller-provided AbortSignal (from the stockDetail live-refresh path).
  // When set, any in-flight fetch aborts cleanly and the function throws
  // an AbortError so the caller can drop the result. Cached hits still
  // return synchronously regardless of signal state — no point aborting
  // a zero-cost lookup. Cache bypass is explicit via opts.noCache.
  const sig = opts.signal || null;
  if (!opts.noCache) {
    const cached = _historyCache.get(key);
    if (cached && Date.now() - cached.ts < HISTORY_TTL_MS) return cached.data;
  }
  if (sig?.aborted) {
    const err = new Error("aborted"); err.name = "AbortError"; throw err;
  }
  const inst = getInstrument(symbol);
  if (!inst) return { ohlc: [], source: "none" };

  // MFs have no Yahoo coverage (MF_<amfi_code>.NS isn't a valid ticker).
  // The synthHistory fallback would silently use the seeded stub walk and
  // serve up garbage as "history". Caller (stockDetail.js MF branch) is
  // expected to use getMfHistory() directly. Returning empty here makes
  // any accidental cross-call fail-fast with a visible empty chart instead
  // of a misleading random walk.
  if (inst.kind === "MF") {
    const empty = { ohlc: [], source: "mf-no-yahoo" };
    _historyCache.set(key, { data: empty, ts: Date.now() });
    return empty;
  }

  let h = null;
  if (inst.kind === "EQUITY" || inst.kind === "ETF") {
    // Preferred: dedicated /api/history endpoint (reliable, returns paise).
    // Falls through to legacy fetchYahooHistory → synthHistory on failure.
    try {
      const res = await fetchJsonWithTimeout(
        `/api/history?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`,
        { signal: sig }
      );
      if (sig?.aborted) {
        const err = new Error("aborted"); err.name = "AbortError"; throw err;
      }
      if (res?.ok && Array.isArray(res.ohlc) && res.ohlc.length) {
        h = { ohlc: res.ohlc, source: "yahoo", host: res.host };
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e;
    }
    if (!h) {
      h = await fetchYahooHistory(symbol, range, interval, { signal: sig }).catch((e) => {
        if (e?.name === "AbortError") throw e;
        return null;
      });
      if (sig?.aborted) {
        const err = new Error("aborted"); err.name = "AbortError"; throw err;
      }
    }
  }
  if (!h) h = synthHistory(symbol);
  _historyCache.set(key, { data: h, ts: Date.now() });
  return h;
}

// ---------- MF NAV history (mfapi.in via /api/mf-history) ------------------
//
// Returns the same shape as getHistory(): { ohlc, source } so callers
// can use it interchangeably. Values are in PAISE (matches /api/history).
//
// tf values mirror the UI TF_MAP keys: "1M", "3M", "6M", "1Y", "3Y", "5Y".
// "1D" and "1W" are not meaningful for NAV history (NAVs publish once per
// day with no intraday candles), so they're remapped to "1M" so the chart
// always renders something useful.
//
// In-memory cache: 1 hour. Falls back to { ohlc: [], source: "none" } on
// network error so the chart shows the loading skeleton rather than crashing.

const MF_HISTORY_TTL_MS = 60 * 60_000;
const _mfHistoryCache = new Map();
// Hotfix47b: extended to remap the new YTD/5Y/MAX timeframes to MF API
// values. The MF API (api/mf-history.py) accepts {1M, 3M, 6M, 1Y, 3Y,
// 5Y, ALL}. Frontend uses YTD/MAX names â€” remap here.
//   1D, 1W   â†’ 1M (MF NAV is daily; sub-day not meaningful)
//   YTD      â†’ 1Y (we fetch 1Y and the chart caller may slice client-
//                  side; for now showing 'last 12 months' is close
//                  enough to YTD for the typical MF user)
//   MAX      â†’ ALL (full AMFI history for the scheme)
//   5Y, 1M, 3M, 6M, 1Y pass through unchanged
const _MF_TF_REMAP = { "1D": "1M", "1W": "1M", "YTD": "1Y", "MAX": "ALL" };

export async function getMfHistory(symbol, tf = "1Y") {
  const mappedTf = _MF_TF_REMAP[tf] || tf;
  const key = `${symbol}|${mappedTf}`;

  const cached = _mfHistoryCache.get(key);
  if (cached && Date.now() - cached.ts < MF_HISTORY_TTL_MS) return cached.data;

  // "MF_118718" → "118718". Reject anything that doesn't look like an
  // AMFI scheme code so we don't burn an upstream call we know will fail.
  const amfiCode = symbol && symbol.startsWith("MF_") ? symbol.slice(3) : symbol;
  if (!amfiCode || !/^\d{1,6}$/.test(amfiCode)) {
    return { ohlc: [], source: "none" };
  }

  let result = null;
  try {
    const res = await fetchJsonWithTimeout(
      `/api/mf-history?code=${encodeURIComponent(amfiCode)}&tf=${encodeURIComponent(mappedTf)}`
    );
    if (res?.ok && Array.isArray(res.ohlc) && res.ohlc.length) {
      result = {
        ohlc:        res.ohlc,
        source:      "mfapi",
        scheme_name: res.scheme_name || "",
        fund_house:  res.fund_house  || "",
        asof_date:   res.asof_date   || "",
        latest_nav_paise: res.latest_nav_paise ?? null,
      };
    }
  } catch (_) {
    // Network failure or timeout → fall through to empty fallback.
  }

  if (!result) result = { ohlc: [], source: "none" };
  _mfHistoryCache.set(key, { data: result, ts: Date.now() });
  return result;
}

// ---------- Live polling ---------------------------------------------------

// Accepts EITHER a fixed symbols array (legacy callers like portfolio.js and
// stockDetail.js) OR a () => string[] callback (Markets grid: viewport-only
// set). The callback is invoked at the start of every tick so the polled
// set tracks scroll/filter changes without re-subscribing. Returning an
// empty list is fine — it just skips the tick.
//
// Behaviours layered on top:
//   * document.hidden gate — ticks skipped while tab is in background; one
//     tick fires immediately on visibilitychange so users coming back don't
//     stare at stale numbers.
//   * Inflight guard — if a previous getQuoteBatch is still pending when
//     interval fires, skip rather than stack (compounds under slow networks).
//   * AbortError-aware — never crashes the polling loop on a network blip.
export function subscribeToQuotes(symbols, onUpdate, intervalMs = 10_000) {
  const isCallback = typeof symbols === "function";
  if (!isCallback && !symbols?.length) return () => {};

  let cancelled = false;
  let inflight = null;
  let timer = null;

  function currentSymbols() {
    if (isCallback) {
      try {
        const out = symbols() || [];
        return Array.isArray(out) ? out : [];
      } catch { return []; }
    }
    return symbols;
  }

  async function tick() {
    if (cancelled) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (inflight) return;
    const syms = currentSymbols();
    if (!syms.length) return;
    const p = (async () => {
      try {
        const quotes = await getQuoteBatch(syms);
        if (!cancelled) onUpdate(quotes);
      } catch (e) {
        if (e?.name !== "AbortError") console.warn("[poll]", e?.message || e);
      }
    })();
    inflight = p;
    try { await p; } finally {
      if (inflight === p) inflight = null;
    }
  }

  function onVisibility() {
    if (cancelled) return;
    if (!document.hidden) tick();
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  tick();
  timer = setInterval(tick, intervalMs);
  return () => {
    cancelled = true;
    if (timer) clearInterval(timer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
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

async function fetchYahooUrl(yahooUrl, opts = {}) {
  const sig = opts.signal || null;
  // Direct first (works in some browsers / same-origin proxies)
  let res = await fetchJsonWithTimeout(yahooUrl, { signal: sig });
  if (sig?.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
  if (res) return res;
  // Public CORS proxies as last resort
  const p1 = `https://corsproxy.io/?url=${encodeURIComponent(yahooUrl)}`;
  res = await fetchJsonWithTimeout(p1, { signal: sig });
  if (sig?.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
  if (res) return res;
  const p2 = `https://api.allorigins.win/get?url=${encodeURIComponent(yahooUrl)}`;
  const w = await fetchJsonWithTimeout(p2, { signal: sig });
  if (sig?.aborted) { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
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

async function fetchYahooHistory(symbol, range, interval, opts = {}) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(yahooTicker(symbol))}?interval=${interval}&range=${range}`;
  const data = await fetchYahooUrl(url, { signal: opts.signal });
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
  // Honour a caller-provided AbortSignal in addition to the internal timeout.
  // If the caller's signal fires first, we reject with AbortError so callers
  // (e.g. stockDetail.refreshHistory) can distinguish "user left the page /
  // switched timeframe" from "network failed". If the timeout fires first,
  // we resolve to null — same silent-degrade behaviour the rest of this
  // module relies on for best-effort quote refreshes.
  const external = options.signal || null;
  // If the external signal is already aborted, short-circuit.
  if (external?.aborted) {
    return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
  }
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let externalAborted = false;
    const onExternalAbort = () => {
      externalAborted = true;
      clearTimeout(t);
      try { ctrl.abort(); } catch {}
      if (external) external.removeEventListener("abort", onExternalAbort);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (external) external.addEventListener("abort", onExternalAbort, { once: true });
    // Build a fetch-safe options bag: drop our `signal` key so we control it.
    const fetchOpts = { ...options };
    delete fetchOpts.signal;
    fetch(url, { ...fetchOpts, signal: ctrl.signal, cache: "no-store" })
      .then(r => {
        clearTimeout(t);
        if (external) external.removeEventListener("abort", onExternalAbort);
        if (externalAborted) return;
        if (!r.ok) { resolve(null); return; }
        return r.json();
      })
      .then(j => { if (!externalAborted) resolve(j || null); })
      .catch(() => {
        clearTimeout(t);
        if (external) external.removeEventListener("abort", onExternalAbort);
        if (externalAborted) return;   // reject already fired
        resolve(null);
      });
  });
}
