// =============================================================================
// MONEY — Paise-first integer math, with safe display helpers.
// Paise = 1/100 of a rupee. ₹1,00,000 = 1_00_00_000 paise.
// NEVER introduce float arithmetic on money.
// =============================================================================

export const PAISE_PER_RUPEE = 100;

export function rupeesToPaise(rupees) {
  return Math.round(Number(rupees) * PAISE_PER_RUPEE);
}

export function paiseToRupees(paise) {
  return Math.round(Number(paise)) / PAISE_PER_RUPEE;
}

/**
 * Format paise as Indian locale currency: "₹1,23,456" or "₹1,23,456.50".
 *
 * Compact mode rules (used in stat tiles, nav cash pill, activity rows,
 * admin summaries, etc.):
 *   - under ₹1 lakh  → full Indian-grouped integer, paise dropped ("₹99,999")
 *   - ≥ ₹1 lakh      → "₹1.23L"   (no space, uppercase L)
 *   - ≥ ₹1 crore     → "₹1.23Cr"  (no space, uppercase Cr)
 *
 * Previously compact mode emitted "₹1.0k" for 1,000-99,999 AND appended
 * the paise component AFTER the L/Cr/k suffix, producing garbage strings
 * like "₹21.0k.50" and "₹1.23 L.78" whenever a mutual-fund position or
 * transfer left a non-zero paise residue. Both behaviours are fixed below:
 *   1. The "k" branch is gone — Indian financial UX (Groww/Zerodha/Kite/
 *      Upstox) never uses it, and its presence alongside "L"/"Cr" caused
 *      both spacing and casing to clash on the same screen.
 *   2. Paise are never appended in compact mode — compact is the summary
 *      view, precision belongs in the full-rupee view.
 *   3. sign:true no longer emits "+₹0" for exactly-zero values — "₹0"
 *      is correct, "+" is only for strictly positive values.
 */
export function formatRupees(paise, { showDecimals = "auto", sign = false, compact = false } = {}) {
  // Number.isFinite covers null, undefined, NaN, +/-Infinity in one check.
  // isNaN(paise) was the old guard, which lets Infinity through and then
  // we'd produce "InfinityCr" downstream — nonsense.
  if (paise == null || !Number.isFinite(Number(paise))) return "—";
  const raw = Math.round(paise);
  const isNegative = raw < 0;
  const abs = Math.abs(raw);
  const rupees = Math.floor(abs / PAISE_PER_RUPEE);
  const p = abs % PAISE_PER_RUPEE;

  let body;
  if (compact) {
    if (rupees >= 1_00_00_000) body = `${(rupees / 1_00_00_000).toFixed(2)}Cr`;
    else if (rupees >= 1_00_000) body = `${(rupees / 1_00_000).toFixed(2)}L`;
    else body = formatIndianNumber(rupees);
  } else {
    body = formatIndianNumber(rupees);
    if (showDecimals === true || (showDecimals === "auto" && p > 0)) {
      body += "." + String(p).padStart(2, "0");
    }
  }

  let prefix;
  if (isNegative) prefix = "-";
  else if (sign && raw > 0) prefix = "+";
  else prefix = "";
  return `${prefix}₹${body}`;
}

/**
 * Indian number grouping: 1,23,45,678
 */
export function formatIndianNumber(n) {
  if (n < 1000) return String(n);
  const str = String(n);
  const last3 = str.slice(-3);
  const rest = str.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
}

/**
 * Format a percent number (e.g. 0.042 → "4.20%" or -0.019 → "-1.90%").
 *
 * Tiny negative values that round to 0.00 at the requested precision
 * used to surface as "-0.00%" because JS toFixed preserves the sign bit
 * across the rounding. We normalise to "0.00%" so the display doesn't
 * lie about direction when magnitude has collapsed to zero.
 */
export function formatPct(n, { decimals = 2, sign = false } = {}) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const pct = n * 100;
  const fixed = pct.toFixed(decimals);
  const roundedNumeric = parseFloat(fixed);
  const body = roundedNumeric === 0 ? (0).toFixed(decimals) : fixed;
  const prefix = sign && roundedNumeric > 0 ? "+" : "";
  return `${prefix}${body}%`;
}

/**
 * Return sign-aware class name for coloring.
 */
export function deltaClass(n) {
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "muted";
}

/**
 * Format a quantity — integer for equities, up to 4 decimals for MFs.
 */
export function formatQty(qty, kind = "EQUITY") {
  if (kind === "MF") {
    return Number(qty).toFixed(4).replace(/\.?0+$/, "");
  }
  return Math.floor(qty).toLocaleString("en-IN");
}
