// =============================================================================
// PRICES — Deterministic, seeded 365-day history for every instrument.
// We generate on-demand using a stable PRNG so the app ships <30kb of JS
// instead of 2MB of JSON. Values are realistic (GBM-ish walk anchored to
// current price + sector beta + known macro events replayed).
//
// Prices are PAISE (integer). Trading days only (no weekends).
// =============================================================================

import { INSTRUMENTS, INSTRUMENT_BY_SYMBOL } from "./universe.js";
import { serverNow, isServerTimeSynced } from "./serverTime.js";

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

// NSE trading holidays (2026) — hardcoded since NSE doesn't expose a
// public holiday API and official dates are a short list. Keep as
// YYYY-MM-DD in IST. Update annually.
// Source: NSE 2026 trading holiday circular.
const NSE_HOLIDAYS_2026 = new Set([
  "2026-01-26",  // Republic Day
  "2026-02-17",  // Mahashivratri
  "2026-03-03",  // Holi
  "2026-03-26",  // Ram Navami
  "2026-04-03",  // Good Friday
  "2026-04-14",  // Ambedkar Jayanti
  "2026-05-01",  // Maharashtra Day
  "2026-08-15",  // Independence Day (Sat — non-effect)
  "2026-08-26",  // Janmashtami
  "2026-09-14",  // Ganesh Chaturthi (approx)
  "2026-10-02",  // Gandhi Jayanti
  "2026-10-21",  // Diwali (Laxmi Puja; special muhurat session happens in evening)
  "2026-11-04",  // Guru Nanak Jayanti
  "2026-12-25",  // Christmas
]);

// 9:15 IST → 15:30 IST for continuous trading (normal session).
// 9:00 → 9:15 is pre-open session — orders accepted but no trading.
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;
const PREOPEN_MIN = 9 * 60;

function istParts(date) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p = fmt.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  return {
    y: p.year,
    m: p.month,
    d: p.day,
    ymd: `${p.year}-${p.month}-${p.day}`,
    weekday: (p.weekday || "").toLowerCase(),   // "mon" .. "sun"
    hour: parseInt(p.hour, 10),
    min: parseInt(p.minute, 10),
    minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
  };
}

function isTradingDay(parts) {
  if (parts.weekday === "sat" || parts.weekday === "sun") return false;
  if (NSE_HOLIDAYS_2026.has(parts.ymd)) return false;
  return true;
}

function labelIstTime(minutes) {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = ((h24 + 11) % 12) + 1;
  const ampm = h24 < 12 ? "AM" : "PM";
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Pretty day offset: "today", "Mon", "Tue 28 Apr". Used in open-next labels.
function labelDay(parts, todayParts) {
  if (parts.ymd === todayParts.ymd) return "today";
  return {
    mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
  }[parts.weekday] || parts.weekday;
}

// Compute the next IST trading-day open and last IST trading-day close
// around a reference serverDate. Used for "Opens Mon 9:15 AM" / "Closed
// at 3:30 PM today" labels.
function findBoundary(serverDate, direction /* +1 = next open, -1 = last close */) {
  // Walk up to 10 days to skip weekends + holidays.
  for (let i = direction === 1 ? 0 : 0; i < 10; i++) {
    const d = new Date(serverDate.getTime() + direction * i * 86400000);
    const p = istParts(d);
    if (!isTradingDay(p)) continue;
    // Same-day open/close is only a boundary if it's actually ahead of / behind now.
    const edgeMin = direction === 1 ? OPEN_MIN : CLOSE_MIN;
    const nowParts = istParts(serverDate);
    if (p.ymd === nowParts.ymd) {
      if (direction === 1 && nowParts.minutes < edgeMin) {
        return { parts: p, minutes: edgeMin };
      }
      if (direction === -1 && nowParts.minutes >= edgeMin) {
        return { parts: p, minutes: edgeMin };
      }
      continue;
    }
    return { parts: p, minutes: edgeMin };
  }
  return null;
}

/**
 * Rich NSE market status. Uses server-authoritative time via serverNow()
 * when available, falls back to local clock otherwise.
 *
 * Returns:
 *   state       — "open" | "pre-open" | "closed"
 *   open        — boolean (true only for state === "open")
 *   label       — "Market Open" | "Pre-Open Session" | "Market Closed"
 *   shortLabel  — "LIVE" | "PRE-OPEN" | "CLOSED" (for tight pills)
 *   istTime     — "14:32 IST"
 *   istDate     — "Tue, 21 Apr"
 *   istDay      — "tue" (lowercase short weekday)
 *   isHoliday   — true if NSE is closed for a listed holiday today
 *   nextOpenAt       — Date of next market open (or null if inside open window)
 *   nextOpenLabel    — "Opens Tue 9:15 AM" etc.
 *   lastCloseLabel   — "Closed at 3:30 PM today" / "Closed Fri 3:30 PM"
 *   degraded    — true when we're using local clock (server-time not yet synced)
 */
export function marketStatus(opts = {}) {
  const now = serverNow();
  const degraded = !isServerTimeSynced();

  const nowParts = istParts(now);
  const tradingDay = isTradingDay(nowParts);
  const isHoliday = tradingDay === false && nowParts.weekday !== "sat" && nowParts.weekday !== "sun"
    ? NSE_HOLIDAYS_2026.has(nowParts.ymd)
    : false;

  let state;
  if (tradingDay && nowParts.minutes >= OPEN_MIN && nowParts.minutes < CLOSE_MIN) state = "open";
  else if (tradingDay && nowParts.minutes >= PREOPEN_MIN && nowParts.minutes < OPEN_MIN) state = "pre-open";
  else state = "closed";

  const nextOpen = state === "open" ? null : findBoundary(now, +1);
  const lastClose = findBoundary(now, -1);

  const nextOpenLabel = nextOpen
    ? `Opens ${labelDay(nextOpen.parts, nowParts)} ${labelIstTime(nextOpen.minutes)}`
    : "";
  const lastCloseLabel = lastClose
    ? `Closed at ${labelIstTime(lastClose.minutes)} ${labelDay(lastClose.parts, nowParts) === "today" ? "today" : labelDay(lastClose.parts, nowParts)}`
    : "";

  // Compose nextOpenAt Date from IST parts so callers can do countdowns.
  let nextOpenAt = null;
  if (nextOpen) {
    const h = Math.floor(nextOpen.minutes / 60);
    const mm = nextOpen.minutes % 60;
    // Build from IST parts: 'YYYY-MM-DDTHH:mm+05:30' → Date
    nextOpenAt = new Date(`${nextOpen.parts.ymd}T${String(h).padStart(2,"0")}:${String(mm).padStart(2,"0")}:00+05:30`);
  }

  const weekdayCap = nowParts.weekday
    ? nowParts.weekday[0].toUpperCase() + nowParts.weekday.slice(1)
    : "";
  const monthName = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(nowParts.m,10)-1] || "";

  return {
    state,
    open: state === "open",
    label: state === "open" ? "Market Open" : state === "pre-open" ? "Pre-Open Session" : "Market Closed",
    shortLabel: state === "open" ? "LIVE" : state === "pre-open" ? "PRE-OPEN" : "CLOSED",
    istTime: `${labelIstTime(nowParts.minutes)} IST`,
    istDate: `${weekdayCap}, ${parseInt(nowParts.d, 10)} ${monthName}`,
    istDay: nowParts.weekday,
    isHoliday,
    nextOpenAt,
    nextOpenLabel,
    lastCloseLabel,
    degraded,
  };
}

