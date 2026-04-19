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
 * Format paise as Indian locale currency: "₹1,23,456" or "₹1,23,456.50"
 * By default hides paise if they're all zeros.
 */
export function formatRupees(paise, { showDecimals = "auto", sign = false, compact = false } = {}) {
  if (paise == null || isNaN(paise)) return "—";
  const isNegative = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / PAISE_PER_RUPEE);
  const p = abs % PAISE_PER_RUPEE;

  let body;
  if (compact) {
    if (rupees >= 1_00_00_000) body = `${(rupees / 1_00_00_000).toFixed(2)} Cr`;
    else if (rupees >= 1_00_000) body = `${(rupees / 1_00_000).toFixed(2)} L`;
    else if (rupees >= 1_000) body = `${(rupees / 1_000).toFixed(1)}k`;
    else body = formatIndianNumber(rupees);
  } else {
    body = formatIndianNumber(rupees);
  }

  if (showDecimals === true || (showDecimals === "auto" && p > 0)) {
    body += "." + String(p).padStart(2, "0");
  }
  const prefix = isNegative ? "-" : sign ? "+" : "";
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
 * Format a percent number (e.g. 0.042 → "4.20%" or -0.019 → "-1.90%")
 */
export function formatPct(n, { decimals = 2, sign = false } = {}) {
  if (n == null || isNaN(n)) return "—";
  const pct = n * 100;
  const prefix = sign && pct > 0 ? "+" : "";
  return `${prefix}${pct.toFixed(decimals)}%`;
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
