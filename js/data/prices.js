// =============================================================================
// PRICES — Deterministic, seeded 365-day history for every instrument.
// We generate on-demand using a stable PRNG so the app ships <30kb of JS
// instead of 2MB of JSON. Values are realistic (GBM-ish walk anchored to
// current price + sector beta + known macro events replayed).
//
// Prices are PAISE (integer). Trading days only (no weekends).
// =============================================================================

import { INSTRUMENTS, INSTRUMENT_BY_SYMBOL } from "./universe.js";

const TRADING_DAYS = 365;   // ~18 months calendar = ~365 trading days
const SECONDS_PER_DAY = 86400000;

/** Mulberry32 — deterministic PRNG seeded by symbol+day. */
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Box-Muller normal draw from two uniform samples. */
function normal(rand) {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Macro events — re-inject known correction days to give data a realistic feel.
// day offsets are from today going back (0 = today).
const MACRO_EVENTS = [
  { day: 20,  allBeta: -0.025, label: "Global rate-hike fears" },
  { day: 55,  allBeta: +0.018, label: "Strong Q2 results" },
  { day: 90,  allBeta: -0.042, label: "Geopolitical shock" },
  { day: 145, allBeta: +0.012, label: "FII inflow surge" },
  { day: 210, allBeta: -0.035, label: "Budget selloff" },
  { day: 260, allBeta: -0.068, label: "Mid-cap correction" },
  { day: 315, allBeta: +0.022, label: "US Fed dovish pivot" },
  { day: 340, allBeta: -0.022, label: "Election jitters" },
];

/**
 * Generate a price series for one symbol, working backwards from today's price.
 * Returns: array[TRADING_DAYS] of objects { t, o, h, l, c, v }. Index 0 is oldest.
 */
export function generateSeries(symbol) {
  const inst = INSTRUMENT_BY_SYMBOL[symbol];
  if (!inst) return [];

  const basePrice = inst.price;      // current (final) price in paise
  const beta = inst.beta || 1;
  const risk = inst.risk || "med";
  const sigma = risk === "high" ? 0.025 : risk === "low" ? 0.012 : 0.017;
  const drift = 0.0003;  // mild upward bias
  const rand = prng(seedFromString(symbol));

  // Walk backwards. Start from current price, apply reverse returns.
  const closes = new Array(TRADING_DAYS);
  closes[TRADING_DAYS - 1] = basePrice;

  for (let i = TRADING_DAYS - 2; i >= 0; i--) {
    const dayOffset = TRADING_DAYS - 1 - i;
    let macro = 0;
    for (const ev of MACRO_EVENTS) {
      if (Math.abs(dayOffset - ev.day) <= 1) {
        macro += ev.allBeta * beta;
      }
    }
    const z = normal(rand);
    const ret = drift + sigma * z + macro;
    // p[i] = p[i+1] / (1+ret) — going backwards
    closes[i] = Math.round(closes[i + 1] / (1 + ret));
  }

  // Build OHLC from closes with tight intraday spread
  const series = new Array(TRADING_DAYS);
  const now = startOfDayIST(Date.now());
  for (let i = 0; i < TRADING_DAYS; i++) {
    const c = closes[i];
    const prev = i === 0 ? c : closes[i - 1];
    const o = i === 0 ? c : prev;
    const intradayVar = Math.abs(c - o) * (0.4 + rand() * 0.8);
    const h = Math.max(c, o) + Math.round(intradayVar * (0.4 + rand() * 0.5));
    const l = Math.min(c, o) - Math.round(intradayVar * (0.4 + rand() * 0.5));
    const v = Math.round(100000 + rand() * 900000);
    // Skip weekends — subtract only trading-day offsets
    const daysBack = TRADING_DAYS - 1 - i;
    const calBack = tradingToCalendar(daysBack);
    series[i] = {
      t: now - calBack * SECONDS_PER_DAY,
      o, h: Math.max(h, o, c), l: Math.min(l, o, c), c,
      v,
    };
  }
  return series;
}

function tradingToCalendar(td) {
  // Approx: 5 trading days = 7 calendar days
  return Math.floor(td * 7 / 5);
}

function startOfDayIST(ms) {
  const d = new Date(ms);
  d.setUTCHours(10, 0, 0, 0); // 3:30 PM IST close
  return d.getTime();
}

// -----------------------------------------------------------------------------
// Cache generated series
// -----------------------------------------------------------------------------
const _cache = new Map();

/**
 * Get full 365-day series (cached). Returned array is readonly — do not mutate.
 */
export function getSeries(symbol) {
  if (!_cache.has(symbol)) _cache.set(symbol, generateSeries(symbol));
  return _cache.get(symbol);
}

/**
 * Get closes-only array for sparkline rendering.
 */
export function getCloses(symbol, lastNDays = null) {
  const s = getSeries(symbol);
  const closes = s.map(k => k.c);
  return lastNDays != null ? closes.slice(-lastNDays) : closes;
}

/**
 * Get a specific day's price. 0 = today (latest), 1 = yesterday, etc.
 */
export function getPriceAt(symbol, daysBack = 0) {
  const s = getSeries(symbol);
  return s[s.length - 1 - daysBack]?.c;
}

/**
 * Compute percentage change between two points (returns DECIMAL e.g. 0.042 = 4.2%)
 */
export function pctChange(from, to) {
  if (!from || !to) return 0;
  return (to - from) / from;
}

/**
 * Get day-over-day change for sparkline color/sign.
 */
export function getTodayChange(symbol) {
  const s = getSeries(symbol);
  if (s.length < 2) return 0;
  const today = s[s.length - 1].c;
  const yesterday = s[s.length - 2].c;
  return pctChange(yesterday, today);
}

/**
 * Get the drawdown from the last N-day high — used for panic detection
 */
export function getDrawdownFromHigh(symbol, days = 30) {
  const s = getSeries(symbol).slice(-days);
  const high = Math.max(...s.map(k => k.h));
  const now = s[s.length - 1].c;
  return pctChange(high, now); // negative
}

/**
 * Get simple 52-week high/low (we only have 365 days so this IS the 52-week)
 */
export function get52wRange(symbol) {
  const s = getSeries(symbol);
  let hi = -Infinity, lo = Infinity;
  for (const k of s) {
    if (k.h > hi) hi = k.h;
    if (k.l < lo) lo = k.l;
  }
  return { hi, lo };
}

/**
 * Return a short friendly market status — for nav bar ticker
 */
export function marketStatus() {
  const now = new Date();
  // Use Intl.DateTimeFormat with Asia/Kolkata — bulletproof against
  // timezone maths errors around UTC day boundaries. (The old manual
  // utcMinutes + 330 trick had a dead-code branch and drifted at midnight.)
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(now).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const istHours = parseInt(parts.hour, 10);
  const istMin = parseInt(parts.minute, 10);
  const istMinutes = istHours * 60 + istMin;
  const weekdayShort = (parts.weekday || "").toLowerCase();
  const isWeekday = !["sat", "sun"].includes(weekdayShort);
  const openMin = 9 * 60 + 15;   // 9:15 IST
  const closeMin = 15 * 60 + 30; // 15:30 IST
  const open = isWeekday && istMinutes >= openMin && istMinutes < closeMin;
  return {
    open,
    label: open ? "Market Open" : "Market Closed",
    istTime: `${String(istHours).padStart(2, "0")}:${String(istMin).padStart(2, "0")} IST`,
  };
}
