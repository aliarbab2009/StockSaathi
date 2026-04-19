// =============================================================================
// ORDER BOOK — Synthesized Level-2 depth around a live price.
// Real Indian retail platforms show 5 levels of bid/ask. We don't have a
// Level-2 feed, but a deterministic-per-symbol depth around the live price
// gives users the "real broker" feel they expect.
// =============================================================================

function seedFromString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

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

/**
 * Build 5 levels of bid + 5 of ask around currentPaise.
 * Deterministic per (symbol, minute-bucket) so the UI feels stable but moves.
 */
export function buildOrderBook(symbol, currentPaise, levels = 5) {
  if (!currentPaise) return { bids: [], asks: [], spread: 0 };
  const minuteBucket = Math.floor(Date.now() / 60000);
  const r = prng(seedFromString(symbol + "_" + minuteBucket));
  const tick = Math.max(5, Math.round(currentPaise * 0.0002));   // ~2bps tick
  const halfSpread = Math.max(tick, Math.round(currentPaise * 0.00025));

  const bids = [];
  const asks = [];
  for (let i = 0; i < levels; i++) {
    const offset = halfSpread + i * tick;
    const bidPrice = currentPaise - offset;
    const askPrice = currentPaise + offset;
    // Quantity decays mildly with depth, with random per-level variance
    const baseQty = Math.floor(1500 + r() * 4000);
    const decay = Math.pow(0.85, i);
    bids.push({ price: bidPrice, qty: Math.round(baseQty * decay * (0.6 + r() * 0.8)) });
    asks.push({ price: askPrice, qty: Math.round(baseQty * decay * (0.6 + r() * 0.8)) });
  }
  return {
    bids,
    asks,
    spread: halfSpread * 2,
    bestBid: bids[0]?.price,
    bestAsk: asks[0]?.price,
  };
}

/**
 * Build a list of recent simulated trades (last ~10 prints).
 */
export function buildRecentTrades(symbol, currentPaise, n = 10) {
  if (!currentPaise) return [];
  const r = prng(seedFromString(symbol + "_trades_" + Math.floor(Date.now() / 30000)));
  const out = [];
  let ts = Date.now();
  for (let i = 0; i < n; i++) {
    const drift = (r() - 0.5) * 0.0008;       // ±0.04%
    const px = Math.round(currentPaise * (1 + drift));
    const qty = Math.floor(1 + r() * 200);
    const side = r() > 0.5 ? "BUY" : "SELL";
    out.push({ ts, price: px, qty, side });
    ts -= Math.floor(2000 + r() * 8000);       // 2-10s back per print
  }
  return out;
}
