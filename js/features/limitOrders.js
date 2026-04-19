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

let _loopTimer = null;
let _stopFn = null;
let _matching = false;              // guard: never run two passes in parallel
const _inFlight = new Set();        // order-ids currently being filled
const _recentFills = new Map();     // order-id → ts, debounce re-fires

export async function listPendingOrders() {
  const client = await sb();
  if (!client) return [];
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return [];
  const { data } = await client.from("limit_orders")
    .select("*")
    .eq("user_id", u.user.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  return data || [];
}

export async function listAllOrders(limit = 50) {
  const client = await sb();
  if (!client) return [];
  const { data: u } = await client.auth.getUser();
  if (!u?.user) return [];
  const { data } = await client.from("limit_orders")
    .select("*")
    .eq("user_id", u.user.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data || [];
}

export async function placeLimitOrder({ symbol, side, qty, limitPricePaise }) {
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
  const { data, error } = await client.rpc("place_limit_order", {
    p_symbol: symbol,
    p_side: side,
    p_qty: qty,
    p_limit_price_paise: Math.round(limitPricePaise),
  });
  if (error) throw new Error(prettifyErr(error.message));
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
