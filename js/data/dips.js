// =============================================================================
// HISTORICAL DIPS — Per-symbol recovery statistics for "last N dips like this"
// coach messages. Buckets by drawdown size (5/7/10/15%).
// Values are realistic but precomputed (would be generated from yfinance in prod).
//
// Shape: { [symbol]: { [dipPct]: { recoveryDays, sampleSize, maxRecoveryDays, minRecoveryDays } } }
// =============================================================================

// Helper: produce dip stats for a stock based on its risk profile.
// Less volatile stocks (low risk) recover faster; high-risk recover slower.
const SYMBOL_RECOVERY = {
  // symbol: base-recovery-days (for a 7% dip)
  RELIANCE: 38, TCS: 32, HDFCBANK: 45, INFY: 34, ICICIBANK: 42,
  BHARTIARTL: 41, SBIN: 48, ITC: 36, LT: 44, HINDUNILVR: 31,
  AXISBANK: 52, KOTAKBANK: 40, BAJFINANCE: 62, HDFCLIFE: 48, SBILIFE: 50,
  HCLTECH: 36, WIPRO: 34, TECHM: 38, LTIM: 40,
  MARUTI: 48, TATAMOTORS: 72, "M&M": 50, EICHERMOT: 55, "BAJAJ-AUTO": 46,
  TATASTEEL: 68, JSWSTEEL: 65, HINDALCO: 72, COALINDIA: 58, ONGC: 55, NTPC: 44, POWERGRID: 40,
  NESTLEIND: 30, BRITANNIA: 32, DABUR: 34, TITAN: 42, ASIANPAINT: 38,
  SUNPHARMA: 35, DRREDDY: 38, CIPLA: 37, DIVISLAB: 48,
  ULTRACEMCO: 50, GRASIM: 48,
  ETERNAL: 96, PAYTM: 110, NYKAA: 95, POLICYBZR: 88, DMART: 48,
  ADANIENT: 108, ADANIPORTS: 78, IRCTC: 70,
};

const DIP_BUCKETS = [5, 7, 10, 15, 20];

function statsForSymbol(symbol) {
  const base = SYMBOL_RECOVERY[symbol] || 50;
  const stats = {};
  for (const pct of DIP_BUCKETS) {
    // Larger dips take longer to recover. Rough scaling: base * (pct/7)^1.2
    const scale = Math.pow(pct / 7, 1.2);
    const median = Math.round(base * scale);
    // Sample size — smaller dips have larger samples (more frequent events)
    let samples;
    if (pct === 5)  samples = 12 + Math.floor(base / 20);
    else if (pct === 7) samples = 7 + Math.floor(base / 30);
    else if (pct === 10) samples = 4 + Math.floor(base / 45);
    else if (pct === 15) samples = 2 + Math.floor(base / 80);
    else samples = Math.max(1, Math.floor(base / 120));
    const spread = Math.max(8, Math.round(median * 0.35));
    stats[pct] = {
      recoveryDays: median,
      sampleSize: samples,
      maxRecoveryDays: median + spread,
      minRecoveryDays: Math.max(1, median - spread),
    };
  }
  return stats;
}

export const DIPS = {};
for (const sym of Object.keys(SYMBOL_RECOVERY)) {
  DIPS[sym] = statsForSymbol(sym);
}

// Nifty composite — used when a symbol has <3 samples for its dip bucket
export const NIFTY_COMPOSITE = {
  5:  { recoveryDays: 22,  sampleSize: 48, minRecoveryDays: 8,   maxRecoveryDays: 48 },
  7:  { recoveryDays: 38,  sampleSize: 24, minRecoveryDays: 14,  maxRecoveryDays: 85 },
  10: { recoveryDays: 72,  sampleSize: 12, minRecoveryDays: 28,  maxRecoveryDays: 160 },
  15: { recoveryDays: 145, sampleSize: 6,  minRecoveryDays: 65,  maxRecoveryDays: 340 },
  20: { recoveryDays: 260, sampleSize: 4,  minRecoveryDays: 112, maxRecoveryDays: 780 },
};

/**
 * Look up the closest bucket AT OR BELOW the requested dip.
 */
export function lookupDip(symbol, drawdownPct) {
  const pct = Math.abs(drawdownPct);
  const bestBucket = DIP_BUCKETS.slice().reverse().find(b => pct >= b);
  if (!bestBucket) return null;

  const symStats = DIPS[symbol]?.[bestBucket];
  if (symStats && symStats.sampleSize >= 3) {
    return { ...symStats, bucket: bestBucket, source: "symbol", symbol };
  }
  const composite = NIFTY_COMPOSITE[bestBucket];
  return { ...composite, bucket: bestBucket, source: "nifty" };
}
