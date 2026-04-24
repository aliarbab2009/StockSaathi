// =============================================================================
// LIMIT ORDERS — actual market-order-like execution simulation.
//
// User places a BUY limit at ₹X → fires when market drops to ≤ X.
// User places a SELL limit at ₹X → fires when market rises to ≥ X.
//
// Execution is client-driven: whenever the user is online and authed, a
// background loop polls live prices for their pending orders and calls the
// fill_limit_order RPC when a condition matches. The fill happens inside a
// Postgres transaction so concurrent users can't double-fill the same order.
// =============================================================================

import { sb } from "../db/supabase.js";
import { getQuoteBatch } from "../data/marketData.js";
import { marketStatus } from "../data/prices.js";

let _loopTimer = null;
let _stopFn = null;
let _matching = false;              // guard: never run two passes in parallel
const _inFlight = new Set();        // order-ids currently being filled
const _recentFills = new Map();     // order-id → ts, debounce re-fires

// Same GoTrue-lock concern as placeLimitOrder — getUser() internally
// touches the same session state that can deadlock. Portfolio polls
// listPendingOrders every 15 s; a stuck call here would silently break
// the live-refresh. Bound it with the same 5-s race.
async function getUserWithTimeout(client) {
  const userP = client.auth.getUser();
  const timeoutP = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("user_timeout")), 5000));
  return Promise.race([userP, timeoutP]);
}

export async function listPendingOrders() {
  const client = await sb();
  if (!client) return [];
  let u = null;
  try {
    const res = await getUserWithTimeout(client);
    u = res?.data;
  } catch (e) {
    if (e?.message === "user_timeout") {
      console.warn("[limit] listPendingOrders getUser timed out");
    }
    return [];
  }
  if (!u?.user) return [];
  // CRITICAL: destructure `error`. Previously only `data` was pulled, so a
  // PostgREST 401 / 403 / 5xx / RLS block silently collapsed to [] with no
  // console signal. Portfolio's 15-s poll would then wipe a previously-
  // populated pendingOrders list despite the user's orders still being in
  // the DB. Now we log any error and return [] so the caller's UI-level
  // ride-out logic (emptyStreak in portfolio.js) can distinguish a
  // transient flap from a genuine empty state.
  const { data, error } = await client.from("limit_orders")
    .select("*")
    .eq("user_id", u.user.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[limit] listPendingOrders select error:", error.message, error.code, error.details);
    return [];
  }
  return data || [];
}

export async function listAllOrders(limit = 50) {
  const client = await sb();
  if (!client) return [];
  let u = null;
  try {
    const res = await getUserWithTimeout(client);
    u = res?.data;
  } catch {
    return [];
  }
  if (!u?.user) return [];
  const { data, error } = await client.from("limit_orders")
    .select("*")
    .eq("user_id", u.user.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[limit] listAllOrders select error:", error.message, error.code, error.details);
    return [];
  }
  return data || [];
}

// 5-second timeout on getSession(). supabase-js 2.45.4 has a documented
// GoTrue `_acquireLock` deadlock: when autoRefreshToken:true races with
// an in-flight getSession() on a stale refresh token, the internal lock
// is never released and getSession() never resolves. A healthy
// getSession returns in ~50 ms, so 5 seconds is far wide of any
// legitimate slow case but saves us from an indefinite hang.
async function sessionWithTimeout(client) {
  const sessionP = client.auth.getSession();
  const timeoutP = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("session_timeout")), 5000));
  return Promise.race([sessionP, timeoutP]);
}

// If getSession times out, the local auth state is corrupt (GoTrue lock
// stuck, stale refresh token, or similar). Clearing it with
// scope:"local" wipes the in-memory + localStorage session WITHOUT
// calling the Supabase server (which would be another potentially-hung
// request). The next click starts from a clean slate — the user just
// needs to log in again.
async function clearCorruptSession(client) {
  try { await client.auth.signOut({ scope: "local" }); } catch {}
}

export async function placeLimitOrder({ symbol, side, qty, limitPricePaise }) {
  console.info("[limit] placeLimitOrder start", { symbol, side, qty, limitPricePaise });
  const client = await sb();
  if (!client) throw new Error("Backend not configured — log in first.");
  // Client-side input validation. The RPC validates too, but catching here
  // gives a readable error and avoids a round-trip for obvious mistakes.
  if (!symbol || typeof symbol !== "string") throw new Error("Missing symbol.");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Quantity must be greater than 0.");
  if (!Number.isFinite(limitPricePaise) || limitPricePaise <= 0) {
    throw new Error("Limit price must be greater than ₹0.");
  }
  if (side !== "BUY" && side !== "SELL") throw new Error("Side must be BUY or SELL.");
  // Verify auth BEFORE the RPC. If getSession hangs (GoTrue lock deadlock
  // in supabase-js 2.45.4), the 5-s race below fires instead of waiting
  // forever. On timeout we clear local auth state so the NEXT retry
  // doesn't hit the same stuck lock.
  console.info("[limit] getSession start");
  const tSession = Date.now();
  let session = null;
  try {
    const result = await sessionWithTimeout(client);
    session = result?.data?.session || null;
    console.info(`[limit] getSession done in ${Date.now() - tSession}ms, session:`, !!session);
  } catch (e) {
    console.error(`[limit] getSession failed after ${Date.now() - tSession}ms:`, e?.message || e);
    await clearCorruptSession(client);
    if (e?.message === "session_timeout") {
      throw new Error("Session check timed out — refresh the page and sign in again.");
    }
    throw e;
  }
  if (!session?.access_token) {
    throw new Error("Your session expired. Refresh the page and sign in again.");
  }
  console.info("[limit] RPC start");
  const t0 = Date.now();
  const { data, error } = await client.rpc("place_limit_order", {
    p_symbol: symbol,
    p_side: side,
    p_qty: qty,
    p_limit_price_paise: Math.round(limitPricePaise),
  });
  console.info(`[limit] RPC done in ${Date.now() - t0}ms`, { ok: !error, hasData: !!data });
  if (error) {
    // Surface the underlying error code + message so we can tell the
    // difference between a missing RPC ("Could not find function"),
    // an RLS block, and a domain-level refusal (insufficient cash etc).
    console.error("[limit] RPC error:", error);
    throw new Error(prettifyErr(error.message || String(error)));
  }
  return data;
}

export async function cancelOrder(orderId) {
  const client = await sb();
  if (!client) throw new Error("Backend not configured.");
  const { data, error } = await client.rpc("cancel_limit_order", { p_order_id: orderId });
  if (error) throw new Error(prettifyErr(error.message));
  return data;
}

/**
 * Attempt to fill a single order at the current market price. Called by the
 * matcher loop. Server validates that the limit condition is actually met.
 */
async function fillOrderAt(orderId, marketPaise) {
  // Idempotency at the client tier: never fire a second fill request while
  // one is in-flight for the same order, and cool-down successful fills for
  // 60 s so a slow DB commit can't be re-triggered before the status flip
  // is visible via realtime.
  if (_inFlight.has(orderId)) return null;
  const lastFill = _recentFills.get(orderId);
  if (lastFill && Date.now() - lastFill < 60_000) return null;
  _inFlight.add(orderId);
  try {
    const client = await sb();
    if (!client) return null;
    const { data, error } = await client.rpc("fill_limit_order", {
      p_order_id: orderId,
      p_market_paise: Math.round(marketPaise),
    });
    if (error) {
      if (!/market has not crossed|already /i.test(error.message)) {
        console.warn("fill_limit_order:", error.message);
      }
      return null;
    }
    if (data?.ok) _recentFills.set(orderId, Date.now());
    return data;
  } finally {
    _inFlight.delete(orderId);
    // bounded map — forget old entries after 10 minutes
    if (_recentFills.size > 200) {
      const cutoff = Date.now() - 600_000;
      for (const [k, v] of _recentFills) if (v < cutoff) _recentFills.delete(k);
    }
  }
}

/**
 * Run one matcher pass: fetch pending orders, fetch quotes, fill matching.
 * The _matching guard means overlapping ticks (slow network → next setInterval
 * fires before the previous finished) silently drop rather than double-fill.
 */
async function matchOnce() {
  if (_matching) return { checked: 0, filled: 0, skipped: true };
  // PRIMARY FIX FOR "QUEUED ORDERS VANISH ON /#/portfolio": the matcher
  // must not fill orders while the market is closed. Before this guard,
  // `matchOnce` ran every 12 s via the global interval started at
  // app.js:45 — regardless of page, regardless of market status. After
  // a user placed an AMO at, say, BUY ₹1327.80 on RELIANCE when the
  // last cached Yahoo close was ≤ ₹1327.80, the matcher's next tick
  // trivially matched `cur <= limit` against the STALE after-hours
  // cached close and called `fill_limit_order` — flipping status from
  // 'pending' to 'filled'. listPendingOrders filters status='pending',
  // so the "queued" order vanished from the portfolio within 12 s with
  // zero feedback. The user saw a ghost.
  //
  // Gate: during after-hours, do nothing. AMOs placed after-hours now
  // correctly wait for the next market-open tick to evaluate against
  // the actual opening price.
  if (!marketStatus().open) {
    return { checked: 0, filled: 0, skipped: "market_closed" };
  }
  _matching = true;
  try {
    const pending = await listPendingOrders();
    if (!pending.length) return { checked: 0, filled: 0 };

    const symbols = [...new Set(pending.map(o => o.symbol))];
    const quotes = await getQuoteBatch(symbols);

    let filled = 0;
    for (const order of pending) {
      const q = quotes[order.symbol];
      if (!q) continue;
      const cur = q.pricePaise;
      const limit = Number(order.limit_price_paise);
      const matches = order.side === "BUY" ? cur <= limit : cur >= limit;
      if (matches) {
        const result = await fillOrderAt(order.id, cur);
        if (result?.ok) filled++;
      }
    }
    return { checked: pending.length, filled };
  } finally {
    _matching = false;
  }
}

/**
 * Start the matcher loop. Idempotent — subsequent calls are no-ops.
 */
export function startLimitMatcher(intervalMs = 12_000) {
  if (_loopTimer) return _stopFn;
  let cancelled = false;

  const tick = async () => {
    if (cancelled) return;
    try { await matchOnce(); } catch (e) { console.warn("limit matcher:", e); }
  };

  tick();   // run once immediately
  _loopTimer = setInterval(tick, intervalMs);
  _stopFn = () => {
    cancelled = true;
    if (_loopTimer) { clearInterval(_loopTimer); _loopTimer = null; }
  };
  return _stopFn;
}

export function stopLimitMatcher() { _stopFn?.(); }

function prettifyErr(msg) {
  if (!msg) return "Something went wrong.";
  if (/insufficient cash/i.test(msg)) return "Not enough cash to reserve.";
  if (/insufficient holding/i.test(msg)) return "You don't hold enough shares.";
  if (/not logged in/i.test(msg)) return "Please log in.";
  if (/invalid side/i.test(msg)) return "Invalid order side.";
  if (/market has not crossed/i.test(msg)) return "Market hasn't reached the limit yet.";
  return msg;
}
