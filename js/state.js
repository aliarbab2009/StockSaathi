// =============================================================================
// STATE — dual-mode reactive store.
//   Supabase mode: Postgres-backed. RLS enforces isolation. Cross-device.
//   Local mode:   per-user localStorage (legacy fallback).
//
// All pages read from getState() synchronously regardless of mode. In Supabase
// mode, js/db/sync.js populates this store from the DB on boot + auth change.
// Writes call DB RPCs first, then update local cache for snappy UI.
// All money is PAISE (integer).
// =============================================================================

import { currentUser } from "./auth/accounts.js";
import { dbApplyTrade, dbAddWatchlist, dbRemoveWatchlist, dbAddCoachMessage } from "./db/sync.js";
import { sb } from "./db/supabase.js";

const STARTING_CASH_PAISE = 1_00_00_000;
const VERSION = 3;

const DEFAULT_STATE = () => ({
  version: VERSION,
  portfolio: { cashPaise: STARTING_CASH_PAISE, startingCashPaise: STARTING_CASH_PAISE },
  holdings: {},
  transactions: [],
  transfers: [],
  inbox: [],
  coachMessages: [],
  watchlist: [],
  friends: [],
  badges: [],
  profile: {
    riskProfile: null, school: null, classCode: null, age: null,
    parentEmail: null, parentConsentAt: null, onboarded: false,
  },
  demo: { crashReplayCompleted: [], firstTradeDone: false },
});

const GLOBAL_SETTINGS_KEY = "ss.settings.v1";
const GLOBAL_SETTINGS_DEFAULTS = {
  theme: "light",
  hinglish: false,
  coachPanelOpen: false,  // Closed by default; user opens via FAB. Prevents
                          // mobile overlay from blocking signup/CTAs.
  anthropicKey: "",
  finnhubKey: "",
  emailjs: { serviceId: "", templateId: "", publicKey: "" },
};

function keyFor(userId) { return `ss.userstate.${userId}`; }

function readUserState(userId) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed;
  } catch { return null; }
}
function writeUserState(userId, st) {
  try { localStorage.setItem(keyFor(userId), JSON.stringify(st)); }
  catch (e) { console.warn("state persist failed:", e); }
}

function readSettings() {
  try {
    const raw = localStorage.getItem(GLOBAL_SETTINGS_KEY);
    return raw ? { ...GLOBAL_SETTINGS_DEFAULTS, ...JSON.parse(raw) } : { ...GLOBAL_SETTINGS_DEFAULTS };
  } catch { return { ...GLOBAL_SETTINGS_DEFAULTS }; }
}
function writeSettings(s) { localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify(s)); }

// --------------------------------------------------------------------------
const listeners = new Set();

let _userState = null;
let _activeUserId = null;
let _settings = readSettings();

function ensureUserLoaded() {
  const user = currentUser();
  if (!user) { _userState = null; _activeUserId = null; return null; }
  if (_activeUserId !== user.id) {
    _activeUserId = user.id;
    _userState = readUserState(user.id) || DEFAULT_STATE();
  }
  return _userState;
}

ensureUserLoaded();

function merge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    if (typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k])
        && typeof over[k] === "object" && over[k] !== null && !Array.isArray(over[k])) {
      out[k] = { ...base[k], ...over[k] };
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

export function getState() {
  ensureUserLoaded();
  const user = currentUser();
  const us = _userState || DEFAULT_STATE();
  return {
    user: {
      id: user?.id || null,
      username: user?.username || null,
      displayName: user?.displayName || null,
      email: user?.email || null,
      avatarColor: user?.avatarColor || "green",
      age: user?.age ?? us.profile.age,
      school: user?.school ?? us.profile.school,
      classCode: user?.classCode ?? us.profile.classCode,
      riskProfile: user?.riskProfile ?? us.profile.riskProfile,
      parentEmail: user?.parentEmail ?? us.profile.parentEmail,
      parentConsentAt: user?.parentConsentAt ?? us.profile.parentConsentAt,
      onboarded: user?.onboarded ?? us.profile.onboarded,
      createdAt: user?.createdAt || null,
    },
    portfolio: us.portfolio,
    holdings: us.holdings,
    transactions: us.transactions,
    transfers: us.transfers,
    inbox: us.inbox,
    coachMessages: us.coachMessages,
    watchlist: us.watchlist,
    friends: us.friends,
    badges: us.badges,
    demo: us.demo,
    settings: _settings,
    isAuthed: !!user,
  };
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(prev) { for (const fn of listeners) fn(getState(), prev); }

// --------------------------------------------------------------------------
export function setState(patch) {
  const prev = getState();
  if (typeof patch === "function") {
    const full = patch(prev);
    applyFullPatch(full, prev);
  } else {
    applyFullPatch(merge(prev, patch), prev);
  }
}

function applyFullPatch(full, prev) {
  if (full.settings) {
    _settings = { ...GLOBAL_SETTINGS_DEFAULTS, ..._settings, ...full.settings };
    writeSettings(_settings);
  }
  if (_activeUserId && _userState) {
    _userState = {
      version: VERSION,
      portfolio: full.portfolio ?? _userState.portfolio,
      holdings: full.holdings ?? _userState.holdings,
      transactions: full.transactions ?? _userState.transactions,
      transfers: full.transfers ?? _userState.transfers,
      inbox: full.inbox ?? _userState.inbox,
      coachMessages: full.coachMessages ?? _userState.coachMessages,
      watchlist: full.watchlist ?? _userState.watchlist,
      friends: full.friends ?? _userState.friends,
      badges: full.badges ?? _userState.badges,
      profile: {
        riskProfile: full.user?.riskProfile ?? _userState.profile.riskProfile,
        school: full.user?.school ?? _userState.profile.school,
        classCode: full.user?.classCode ?? _userState.profile.classCode,
        age: full.user?.age ?? _userState.profile.age,
        parentEmail: full.user?.parentEmail ?? _userState.profile.parentEmail,
        parentConsentAt: full.user?.parentConsentAt ?? _userState.profile.parentConsentAt,
        onboarded: full.user?.onboarded ?? _userState.profile.onboarded,
      },
      demo: full.demo ?? _userState.demo,
    };
    writeUserState(_activeUserId, _userState);
  }
  emit(prev);
}

export function setSetting(key, value) {
  _settings = { ..._settings, [key]: value };
  writeSettings(_settings);
  emit(getState());
}
export function setSettings(patch) {
  _settings = { ..._settings, ...patch };
  writeSettings(_settings);
  emit(getState());
}

export function switchUser() {
  _activeUserId = null;
  _userState = null;
  ensureUserLoaded();
  emit(getState());
}

// ---- profile mutations (DB-backed via auth/accounts.js:updateProfile) ----
import { updateProfile } from "./auth/accounts.js";

export async function completeOnboarding({ age, school, classCode, riskProfile }) {
  try {
    await updateProfile({
      age, school, classCode, riskProfile,
      onboarded: true,
    });
  } catch (e) { console.warn("onboarding profile update failed:", e); }
  setState(s => ({
    ...s,
    user: { ...s.user, age, school, classCode, riskProfile, onboarded: true },
  }));
}

export function recordCoachMessage(msg) {
  const enriched = { ...msg, id: msg.id || genId(), ts: msg.ts || Date.now() };
  setState(s => ({ ...s, coachMessages: [...s.coachMessages, enriched] }));
  // Fire-and-forget DB write
  dbAddCoachMessage(enriched).catch(() => {});
}

export function addToWatchlist(symbol) {
  setState(s => ({ ...s, watchlist: s.watchlist.includes(symbol) ? s.watchlist : [...s.watchlist, symbol] }));
  dbAddWatchlist(symbol).catch(() => {});
}
export function removeFromWatchlist(symbol) {
  setState(s => ({ ...s, watchlist: s.watchlist.filter(x => x !== symbol) }));
  dbRemoveWatchlist(symbol).catch(() => {});
}

export function genId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---- Trades — DB-backed if available, else local --------------------------
export async function applyTrade({ symbol, side, qty, pricePaise, biasFlags = [], idempotencyKey }) {
  const valuePaise = Math.round(qty * pricePaise);
  const s = getState();
  if (!s.isAuthed) throw new Error("Please log in to trade.");

  // Idempotency: check local cache
  if (idempotencyKey) {
    const existing = s.transactions.find(t => t.idempotencyKey === idempotencyKey);
    if (existing) return existing;
  }

  const client = await sb();
  if (client) {
    // DB path — atomic RPC call
    await dbApplyTrade({ symbol, side, qty, pricePaise, idempotencyKey, biasFlags });
    // Optimistic local update (sync.js will reconcile on next load)
    const txn = makeLocalTxn({ symbol, side, qty, pricePaise, valuePaise, biasFlags, idempotencyKey });
    applyLocalTradeEffect(txn);
    return txn;
  }

  // Local fallback (same as before)
  if (side === "BUY") {
    if (valuePaise > s.portfolio.cashPaise) {
      throw new Error(`Insufficient cash. Need ₹${(valuePaise / 100).toLocaleString("en-IN")}, have ₹${(s.portfolio.cashPaise / 100).toLocaleString("en-IN")}.`);
    }
  } else {
    const h = s.holdings[symbol];
    if (!h || h.qty < qty - 1e-9) {
      throw new Error(`Insufficient quantity to sell. You hold ${h?.qty || 0}.`);
    }
  }
  const txn = makeLocalTxn({ symbol, side, qty, pricePaise, valuePaise, biasFlags, idempotencyKey });
  applyLocalTradeEffect(txn);
  return txn;
}

function makeLocalTxn({ symbol, side, qty, pricePaise, valuePaise, biasFlags, idempotencyKey }) {
  return {
    id: genId(),
    idempotencyKey: idempotencyKey || genId(),
    ts: Date.now(),
    symbol, side, qty, pricePaise, valuePaise, biasFlags,
  };
}

function applyLocalTradeEffect(txn) {
  setState(state => {
    const { symbol, side, qty, pricePaise, valuePaise } = txn;
    const cur = state.holdings[symbol];
    let nextHoldings;
    if (side === "BUY") {
      const newQty = (cur?.qty || 0) + qty;
      const newAvg = cur
        ? Math.round((cur.avgCostPaise * cur.qty + valuePaise) / newQty)
        : pricePaise;
      nextHoldings = {
        ...state.holdings,
        [symbol]: { qty: newQty, avgCostPaise: newAvg, firstBoughtAt: cur?.firstBoughtAt || Date.now() },
      };
    } else {
      const remainingQty = cur.qty - qty;
      if (remainingQty <= 1e-9) {
        const { [symbol]: _, ...rest } = state.holdings;
        nextHoldings = rest;
      } else {
        nextHoldings = { ...state.holdings, [symbol]: { ...cur, qty: remainingQty } };
      }
    }
    const cashDelta = side === "BUY" ? -valuePaise : +valuePaise;
    return {
      ...state,
      portfolio: { ...state.portfolio, cashPaise: state.portfolio.cashPaise + cashDelta },
      holdings: nextHoldings,
      transactions: [...state.transactions, txn],
      demo: { ...state.demo, firstTradeDone: true },
    };
  });
}

// --- Derived selectors ----------------------------------------------------
import { getPriceAt } from "./data/prices.js";

export function getHoldingsValue(state = getState()) {
  let total = 0;
  for (const [sym, h] of Object.entries(state.holdings)) {
    const px = getPriceAt(sym, 0);
    if (px != null) total += Math.round(h.qty * px);
  }
  return total;
}
export function getPortfolioValue(state = getState()) {
  return state.portfolio.cashPaise + getHoldingsValue(state);
}
export function getPortfolioReturnPct(state = getState()) {
  const total = getPortfolioValue(state);
  const start = state.portfolio.startingCashPaise;
  return start ? (total - start) / start : 0;
}
export function getHoldingPLPaise(symbol, state = getState()) {
  const h = state.holdings[symbol];
  if (!h) return 0;
  const curPx = getPriceAt(symbol, 0);
  return Math.round((curPx - h.avgCostPaise) * h.qty);
}
export function getHoldingPLPct(symbol, state = getState()) {
  const h = state.holdings[symbol];
  if (!h) return 0;
  const curPx = getPriceAt(symbol, 0);
  return curPx ? (curPx - h.avgCostPaise) / h.avgCostPaise : 0;
}

export function resetCurrentPortfolio() {
  setState(s => ({
    ...s,
    portfolio: { cashPaise: STARTING_CASH_PAISE, startingCashPaise: STARTING_CASH_PAISE },
    holdings: {}, transactions: [], transfers: [], inbox: [],
    coachMessages: [],
    demo: { crashReplayCompleted: [], firstTradeDone: false },
  }));
}

window.addEventListener("storage", (e) => {
  if (!e.key) return;
  if (e.key === GLOBAL_SETTINGS_KEY) { _settings = readSettings(); emit(getState()); return; }
  if (_activeUserId && e.key === keyFor(_activeUserId)) {
    _userState = readUserState(_activeUserId) || DEFAULT_STATE();
    emit(getState());
  }
});
