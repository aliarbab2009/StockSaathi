// =============================================================================
// CHART PRIMITIVES — Pure SVG. No deps.
// Exports:
//   sparkline(closes, opts) → SVG string
//   lineChart(series, opts) → SVG string
//   dualLineChart(series1, series2, opts) → SVG string
//   candleChart(ohlcArray, opts) → SVG string
//   areaChart(series, opts) → SVG string
// Every chart works at any width; they use viewBox for responsiveness.
// =============================================================================

function minMax(arr) {
  let min = Infinity, max = -Infinity;
  for (const v of arr) {
    if (v == null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return { min: 0, max: 1 };
  if (min === max) { min -= 1; max += 1; }
  return { min, max };
}

function pad(n) {
  return Math.max(0, Math.min(1, n));
}

function buildPath(values, width, height, { min, max, paddingTop = 6, paddingBottom = 6 } = {}) {
  if (!values.length) return "";
  const range = max - min || 1;
  const plotH = height - paddingTop - paddingBottom;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  let d = "";
  for (let i = 0; i < values.length; i++) {
    const x = i * stepX;
    const y = paddingTop + plotH - ((values[i] - min) / range) * plotH;
    d += (i === 0 ? "M" : "L") + x.toFixed(2) + "," + y.toFixed(2) + " ";
  }
  return d.trim();
}

function buildAreaPath(values, width, height, opts) {
  const linePath = buildPath(values, width, height, opts);
  if (!linePath) return "";
  return linePath + ` L${width},${height} L0,${height} Z`;
}

// ---- SPARKLINE (small, stock-card) --------------------------------------
export function sparkline(closes, { width = 220, height = 40, color = "#10B981", strokeWidth = 1.5 } = {}) {
  if (!closes || closes.length < 2) return "";
  const { min, max } = minMax(closes);
  const trend = closes[closes.length - 1] - closes[0];
  const useColor = trend >= 0 ? "var(--green, #10B981)" : "var(--red, #EF4444)";
  const path = buildPath(closes, width, height, { min, max, paddingTop: 2, paddingBottom: 2 });
  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${path}" fill="none" stroke="${useColor}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
}

// ---- LINE CHART (full) ---------------------------------------------------
export function lineChart(values, {
  width = 800, height = 300, color = "var(--brand)",
  showGrid = true, showAxes = true, areaFill = true,
  min: minArg = null, max: maxArg = null,
  paddingTop = 20, paddingBottom = 28, paddingLeft = 52, paddingRight = 20,
} = {}) {
  if (!values.length) return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}"></svg>`;
  const { min: autoMin, max: autoMax } = minMax(values);
  const min = minArg != null ? minArg : autoMin - (autoMax - autoMin) * 0.08;
  const max = maxArg != null ? maxArg : autoMax + (autoMax - autoMin) * 0.08;
  const plotW = width - paddingLeft - paddingRight;
  const plotH = height - paddingTop - paddingBottom;

  const toX = (i) => paddingLeft + (values.length > 1 ? (i / (values.length - 1)) * plotW : plotW / 2);
  const toY = (v) => paddingTop + plotH - ((v - min) / (max - min)) * plotH;

  let gridLines = "";
  if (showGrid) {
    for (let i = 0; i <= 4; i++) {
      const y = paddingTop + (i / 4) * plotH;
      gridLines += `<line x1="${paddingLeft}" x2="${width - paddingRight}" y1="${y}" y2="${y}" />`;
    }
  }

  let yLabels = "";
  if (showAxes) {
    for (let i = 0; i <= 4; i++) {
      const y = paddingTop + (i / 4) * plotH;
      const v = max - (i / 4) * (max - min);
      const label = formatAxisNumber(v);
      yLabels += `<text class="chart-axis-label" x="${paddingLeft - 8}" y="${y + 4}" text-anchor="end">${label}</text>`;
    }
  }

  let pathD = "";
  for (let i = 0; i < values.length; i++) {
    pathD += (i === 0 ? "M" : "L") + toX(i).toFixed(2) + "," + toY(values[i]).toFixed(2) + " ";
  }
  const areaD = pathD + ` L${toX(values.length - 1)},${paddingTop + plotH} L${toX(0)},${paddingTop + plotH} Z`;

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      ${showGrid ? `<g class="chart-grid">${gridLines}</g>` : ""}
      ${areaFill ? `<path d="${areaD}" fill="${color}" class="chart-area" opacity="0.14" />` : ""}
      <path d="${pathD.trim()}" class="chart-line" stroke="${color}" />
      ${yLabels}
    </svg>
  `;
}

// ---- DUAL LINE CHART — for crash replay (held vs panic-sold) ------------
export function dualLineChart({ held, panic, height = 280, width = 800, currentIndex = null }) {
  if (!held.length) return "";
  const all = [...held, ...panic];
  const { min: dataMin, max: dataMax } = minMax(all);
  const range = dataMax - dataMin;
  const min = dataMin - range * 0.08;
  const max = dataMax + range * 0.08;
  const paddingLeft = 60, paddingRight = 20, paddingTop = 20, paddingBottom = 28;
  const plotW = width - paddingLeft - paddingRight;
  const plotH = height - paddingTop - paddingBottom;
  const toX = (i) => paddingLeft + (held.length > 1 ? (i / (held.length - 1)) * plotW : 0);
  const toY = (v) => paddingTop + plotH - ((v - min) / (max - min)) * plotH;

  let heldPath = "", panicPath = "";
  for (let i = 0; i < held.length; i++) {
    heldPath += (i === 0 ? "M" : "L") + toX(i).toFixed(1) + "," + toY(held[i]).toFixed(1) + " ";
    panicPath += (i === 0 ? "M" : "L") + toX(i).toFixed(1) + "," + toY(panic[i]).toFixed(1) + " ";
  }

  // Starting line marker
  const startY = toY(held[0]);
  let gridLines = "";
  for (let i = 0; i <= 4; i++) {
    const y = paddingTop + (i / 4) * plotH;
    gridLines += `<line x1="${paddingLeft}" x2="${width - paddingRight}" y1="${y}" y2="${y}" />`;
  }
  let yLabels = "";
  for (let i = 0; i <= 4; i++) {
    const y = paddingTop + (i / 4) * plotH;
    const v = max - (i / 4) * (max - min);
    yLabels += `<text class="chart-axis-label" x="${paddingLeft - 8}" y="${y + 4}" text-anchor="end">₹${formatAxisNumber(v)}</text>`;
  }

  // Marker for current position (vertical line)
  let scrubber = "";
  if (currentIndex != null && currentIndex >= 0 && currentIndex < held.length) {
    const x = toX(currentIndex);
    const hy = toY(held[currentIndex]);
    const py = toY(panic[currentIndex]);
    scrubber = `
      <line x1="${x}" x2="${x}" y1="${paddingTop}" y2="${paddingTop + plotH}" stroke="var(--brand)" stroke-dasharray="3 3" stroke-width="1" opacity="0.6" />
      <circle cx="${x}" cy="${hy}" r="5" fill="var(--green)" stroke="var(--bg-1)" stroke-width="2" />
      <circle cx="${x}" cy="${py}" r="5" fill="var(--red)" stroke="var(--bg-1)" stroke-width="2" />
    `;
  }

  const heldEnd = held[held.length - 1];
  const panicEnd = panic[panic.length - 1];

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <defs>
        <linearGradient id="heldFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--green)" stop-opacity="0.25" />
          <stop offset="100%" stop-color="var(--green)" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="panicFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--red)" stop-opacity="0.2" />
          <stop offset="100%" stop-color="var(--red)" stop-opacity="0" />
        </linearGradient>
      </defs>
      <g class="chart-grid">${gridLines}</g>
      <line x1="${paddingLeft}" x2="${width - paddingRight}" y1="${startY}" y2="${startY}" stroke="var(--text-3)" stroke-dasharray="4 4" stroke-width="1" opacity="0.6" />
      <text class="chart-axis-label" x="${width - paddingRight}" y="${startY - 4}" text-anchor="end">Start: ₹${formatAxisNumber(held[0])}</text>

      <path d="${heldPath} L${toX(held.length - 1)},${paddingTop + plotH} L${toX(0)},${paddingTop + plotH} Z" fill="url(#heldFill)" />
      <path d="${panicPath} L${toX(panic.length - 1)},${paddingTop + plotH} L${toX(0)},${paddingTop + plotH} Z" fill="url(#panicFill)" />
      <path d="${heldPath.trim()}" fill="none" stroke="var(--green)" stroke-width="2.5" />
      <path d="${panicPath.trim()}" fill="none" stroke="var(--red)" stroke-width="2.5" stroke-dasharray="4 3" />

      ${scrubber}
      ${yLabels}

      <g>
        <circle cx="${paddingLeft + 8}" cy="${paddingTop - 4}" r="5" fill="var(--green)" />
        <text x="${paddingLeft + 20}" y="${paddingTop}" class="chart-axis-label" fill="var(--text-1)">If you held</text>
        <circle cx="${paddingLeft + 110}" cy="${paddingTop - 4}" r="5" fill="var(--red)" />
        <text x="${paddingLeft + 122}" y="${paddingTop}" class="chart-axis-label" fill="var(--text-1)">If you panic-sold</text>
      </g>
    </svg>
  `;
}

// ---- CANDLE CHART -------------------------------------------------------
export function candleChart(ohlc, { width = 800, height = 340, max: maxArg = null, min: minArg = null } = {}) {
  if (!ohlc.length) return "";
  const allHighs = ohlc.map(k => k.h);
  const allLows = ohlc.map(k => k.l);
  const { min: dataMin, max: dataMax } = (() => {
    const hi = Math.max(...allHighs);
    const lo = Math.min(...allLows);
    return { min: lo, max: hi };
  })();
  const pad = (dataMax - dataMin) * 0.08;
  const min = minArg != null ? minArg : dataMin - pad;
  const max = maxArg != null ? maxArg : dataMax + pad;

  const paddingLeft = 60, paddingRight = 20, paddingTop = 20, paddingBottom = 28;
  const plotW = width - paddingLeft - paddingRight;
  const plotH = height - paddingTop - paddingBottom;
  const toX = (i) => paddingLeft + (ohlc.length > 1 ? (i / (ohlc.length - 1)) * plotW : 0);
  const toY = (v) => paddingTop + plotH - ((v - min) / (max - min)) * plotH;

  const candleW = Math.max(1.5, plotW / ohlc.length * 0.6);

  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const y = paddingTop + (i / 4) * plotH;
    grid += `<line x1="${paddingLeft}" x2="${width - paddingRight}" y1="${y}" y2="${y}" />`;
  }

  let yLabels = "";
  for (let i = 0; i <= 4; i++) {
    const y = paddingTop + (i / 4) * plotH;
    const v = max - (i / 4) * (max - min);
    yLabels += `<text class="chart-axis-label" x="${paddingLeft - 8}" y="${y + 4}" text-anchor="end">₹${formatAxisNumber(v / 100)}</text>`;
  }

  let candles = "";
  for (let i = 0; i < ohlc.length; i++) {
    const k = ohlc[i];
    const x = toX(i);
    const up = k.c >= k.o;
    const cls = up ? "chart-candle-up" : "chart-candle-down";
    const yH = toY(k.h);
    const yL = toY(k.l);
    const yO = toY(k.o);
    const yC = toY(k.c);
    const bodyY = Math.min(yO, yC);
    const bodyH = Math.max(1, Math.abs(yO - yC));
    candles += `
      <line class="${cls}" x1="${x}" x2="${x}" y1="${yH}" y2="${yL}" stroke-width="1" />
      <rect class="${cls}" x="${x - candleW / 2}" y="${bodyY}" width="${candleW}" height="${bodyH}" />
    `;
  }

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" aria-hidden="true" preserveAspectRatio="none">
      <g class="chart-grid">${grid}</g>
      ${candles}
      ${yLabels}
    </svg>
  `;
}

// ---- AREA CHART (portfolio over time) -----------------------------------
export function areaChart(values, opts = {}) {
  return lineChart(values, { ...opts, areaFill: true });
}

function formatAxisNumber(v) {
  const abs = Math.abs(v);
  if (abs >= 1e7) return (v / 1e7).toFixed(2) + "Cr";
  if (abs >= 1e5) return (v / 1e5).toFixed(2) + "L";
  if (abs >= 1e3) return Math.round(v / 1e3) + "k";
  return Math.round(v).toString();
}
