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
      <circle cx="${x}" cy="${hy}" r="5" fill="var(--positive)" stroke="var(--bg)" stroke-width="2" />
      <circle cx="${x}" cy="${py}" r="5" fill="var(--negative)" stroke="var(--bg)" stroke-width="2" />
    `;
  }

  const heldEnd = held[held.length - 1];
  const panicEnd = panic[panic.length - 1];

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <defs>
        <linearGradient id="heldFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--positive)" stop-opacity="0.25" />
          <stop offset="100%" stop-color="var(--positive)" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="panicFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--negative)" stop-opacity="0.2" />
          <stop offset="100%" stop-color="var(--negative)" stop-opacity="0" />
        </linearGradient>
      </defs>
      <g class="chart-grid">${gridLines}</g>
      <line x1="${paddingLeft}" x2="${width - paddingRight}" y1="${startY}" y2="${startY}" stroke="var(--text-faint)" stroke-dasharray="4 4" stroke-width="1" opacity="0.6" />
      <text class="chart-axis-label" x="${width - paddingRight}" y="${startY - 4}" text-anchor="end">Start: ₹${formatAxisNumber(held[0])}</text>

      <path d="${heldPath} L${toX(held.length - 1)},${paddingTop + plotH} L${toX(0)},${paddingTop + plotH} Z" fill="url(#heldFill)" />
      <path d="${panicPath} L${toX(panic.length - 1)},${paddingTop + plotH} L${toX(0)},${paddingTop + plotH} Z" fill="url(#panicFill)" />
      <path d="${heldPath.trim()}" fill="none" stroke="var(--positive)" stroke-width="2.5" />
      <path d="${panicPath.trim()}" fill="none" stroke="var(--negative)" stroke-width="2.5" stroke-dasharray="4 3" />

      ${scrubber}
      ${yLabels}

      <g>
        <circle cx="${paddingLeft + 8}" cy="${paddingTop - 4}" r="5" fill="var(--positive)" />
        <text x="${paddingLeft + 20}" y="${paddingTop}" class="chart-axis-label" fill="var(--text-muted)">If you held</text>
        <circle cx="${paddingLeft + 110}" cy="${paddingTop - 4}" r="5" fill="var(--negative)" />
        <text x="${paddingLeft + 122}" y="${paddingTop}" class="chart-axis-label" fill="var(--text-muted)">If you panic-sold</text>
      </g>
    </svg>
  `;
}

// ---- STOCK CHART (candle / area modes, X-axis, hover crosshair) ---------
//
// Usage:
//   container.innerHTML = stockChart(ohlc, { mode: "candle" | "area" });
//   attachStockChartHover(container, ohlc, { mode });
//
// The chart emits a live-price overlay (last close dashed line + rightmost
// label) and leaves two empty <g> slots (#chart-crosshair, #chart-tooltip)
// that attachStockChartHover populates on mousemove. No external deps;
// still all SVG so it works offline + in the SW cache.
// =========================================================================

export function stockChart(ohlc, {
  width = 800, height = 360,
  mode = "candle",          // "candle" | "area"
  max: maxArg = null, min: minArg = null,
  showVolume = false,       // reserved for later
} = {}) {
  if (!ohlc.length) return "";
  const allHighs = ohlc.map(k => k.h ?? k.c);
  const allLows  = ohlc.map(k => k.l ?? k.c);
  const dataMax = Math.max(...allHighs);
  const dataMin = Math.min(...allLows);
  const pad = (dataMax - dataMin) * 0.08 || dataMax * 0.01;
  const min = minArg != null ? minArg : dataMin - pad;
  const max = maxArg != null ? maxArg : dataMax + pad;

  const paddingLeft = 60, paddingRight = 56, paddingTop = 16, paddingBottom = 30;
  const plotW = width - paddingLeft - paddingRight;
  const plotH = height - paddingTop - paddingBottom;
  const toX = (i) => paddingLeft + (ohlc.length > 1 ? (i / (ohlc.length - 1)) * plotW : 0);
  const toY = (v) => paddingTop + plotH - ((v - min) / (max - min)) * plotH;

  // Y gridlines + labels
  let grid = "", yLabels = "";
  for (let i = 0; i <= 4; i++) {
    const y = paddingTop + (i / 4) * plotH;
    const v = max - (i / 4) * (max - min);
    grid += `<line x1="${paddingLeft}" x2="${width - paddingRight}" y1="${y}" y2="${y}" />`;
    yLabels += `<text class="chart-axis-label" x="${paddingLeft - 8}" y="${y + 4}" text-anchor="end">₹${formatAxisNumber(v / 100)}</text>`;
  }

  // X-axis ticks: 5 evenly-spaced labels from first to last candle.
  // Format depends on how tightly the data is packed in time.
  let xLabels = "";
  const nTicks = Math.min(5, ohlc.length);
  const spanMs = ohlc[ohlc.length - 1].t - ohlc[0].t;
  const isIntraday = spanMs > 0 && spanMs < 3 * 86400000;  // <3 days
  const fmtT = (tms) => {
    const d = new Date(tms);
    if (isIntraday) {
      return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
    }
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" });
  };
  for (let i = 0; i < nTicks; i++) {
    const idx = Math.round(i * (ohlc.length - 1) / (nTicks - 1 || 1));
    const x = toX(idx);
    const k = ohlc[idx];
    xLabels += `<text class="chart-axis-label" x="${x}" y="${height - 10}" text-anchor="middle">${fmtT(k.t)}</text>`;
  }

  // Body
  let body = "";
  if (mode === "area") {
    // Build path from close prices
    let d = "";
    for (let i = 0; i < ohlc.length; i++) {
      d += (i === 0 ? "M" : "L") + toX(i).toFixed(2) + "," + toY(ohlc[i].c).toFixed(2) + " ";
    }
    const areaD = d + ` L${toX(ohlc.length - 1)},${paddingTop + plotH} L${toX(0)},${paddingTop + plotH} Z`;
    const firstClose = ohlc[0].c;
    const lastClose = ohlc[ohlc.length - 1].c;
    const up = lastClose >= firstClose;
    const color = up ? "var(--positive)" : "var(--negative)";
    body = `
      <path d="${areaD}" fill="${color}" opacity="0.12" />
      <path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" />
    `;
  } else {
    // Candles
    const candleW = Math.max(1.5, plotW / ohlc.length * 0.6);
    for (let i = 0; i < ohlc.length; i++) {
      const k = ohlc[i];
      const x = toX(i);
      const up = k.c >= k.o;
      const cls = up ? "chart-candle-up" : "chart-candle-down";
      const yH = toY(k.h), yL = toY(k.l), yO = toY(k.o), yC = toY(k.c);
      const bodyY = Math.min(yO, yC);
      const bodyH = Math.max(1, Math.abs(yO - yC));
      body += `
        <line class="${cls}" x1="${x}" x2="${x}" y1="${yH}" y2="${yL}" stroke-width="1" />
        <rect class="${cls}" x="${x - candleW / 2}" y="${bodyY}" width="${candleW}" height="${bodyH}" />
      `;
    }
  }

  // Previous-close baseline (first candle's open as anchor)
  const baseY = toY(ohlc[0].o ?? ohlc[0].c);
  const baseline = `<line x1="${paddingLeft}" x2="${width - paddingRight}" y1="${baseY}" y2="${baseY}" stroke="var(--text-dim, #878E9C)" stroke-width="1" stroke-dasharray="3,4" opacity="0.4" />`;

  // Last-price label on right edge
  const lastY = toY(ohlc[ohlc.length - 1].c);
  const lastLabel = `
    <g transform="translate(${width - paddingRight + 2}, ${lastY})">
      <rect x="0" y="-10" width="52" height="20" rx="4" fill="var(--brand, #00B386)" />
      <text x="26" y="4" text-anchor="middle" font-size="11" font-weight="700" fill="#fff" font-family="var(--font-mono, monospace)">₹${(ohlc[ohlc.length - 1].c / 100).toFixed(2)}</text>
    </g>`;

  return `
    <div class="stock-chart" style="position:relative;">
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"
           data-w="${width}" data-h="${height}"
           data-pl="${paddingLeft}" data-pr="${paddingRight}"
           data-pt="${paddingTop}" data-pb="${paddingBottom}"
           data-min="${min}" data-max="${max}" data-n="${ohlc.length}">
        <g class="chart-grid">${grid}</g>
        ${baseline}
        ${body}
        ${yLabels}
        ${xLabels}
        ${lastLabel}
        <g class="chart-cursor" style="display:none;">
          <!-- Single vertical line tracks the cursor X. The dot sits on the
               NEAREST bar's close (same data the tooltip reports — so the
               mark is never "off" relative to the numbers next to it), with
               a soft breathing halo + a punch-out surface ring on the core
               for contrast against any chart colour. Halo pulses by
               animating r directly (not transform:scale) — scale-on-SVG is
               inconsistent across browsers and caused the drift the user
               saw. -->
          <line class="chart-cursor-x" x1="0" x2="0" y1="${paddingTop}" y2="${paddingTop + plotH}"
                stroke="var(--text, #E2E5EC)" stroke-width="1.5" opacity="0.7" />
          <circle class="chart-dot-halo breathing" cx="-50" cy="-50" r="10" fill="currentColor" />
          <circle class="chart-dot-core breathing" cx="-50" cy="-50" r="4.5" fill="currentColor" stroke="var(--surface, #13161E)" stroke-width="2" />
        </g>
      </svg>
      <div class="chart-tooltip" style="position:absolute; pointer-events:none; display:none; background:var(--surface-elev, #191C26); border:1px solid var(--border, #262A36); border-radius:8px; padding:8px 10px; font-size:11px; font-family:var(--font-mono, monospace); line-height:1.5; box-shadow:var(--sh-md); white-space:nowrap; z-index:2;"></div>
    </div>
  `;
}

// Back-compat aliases — existing callers of candleChart() still work.
export function candleChart(ohlc, opts = {}) { return stockChart(ohlc, { ...opts, mode: "candle" }); }

// ---- HOVER INTERACTION --------------------------------------------------
// Call AFTER the chart HTML has been inserted into `container`.
// Re-call on every re-render. Cleans up automatically when container empties.
export function attachStockChartHover(container, ohlc, { mode = "candle" } = {}) {
  if (!container || !ohlc?.length) return () => {};
  const svg = container.querySelector(".chart-svg");
  const tooltip = container.querySelector(".chart-tooltip");
  const cursor = container.querySelector(".chart-cursor");
  const cursorX = container.querySelector(".chart-cursor-x");
  const dotHalo = container.querySelector(".chart-dot-halo");
  const dotCore = container.querySelector(".chart-dot-core");
  if (!svg || !tooltip || !cursor || !cursorX) return () => {};

  const W = +svg.dataset.w, H = +svg.dataset.h;
  const PL = +svg.dataset.pl, PR = +svg.dataset.pr;
  const PT = +svg.dataset.pt, PB = +svg.dataset.pb;
  const MIN = +svg.dataset.min, MAX = +svg.dataset.max;
  const N = +svg.dataset.n;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;
  const toX = (i) => PL + (N > 1 ? (i / (N - 1)) * plotW : 0);
  const toY = (v) => PT + plotH - ((v - MIN) / (MAX - MIN)) * plotH;
  let lastIdx = -1, lastColor = "";

  function onMove(e) {
    const rect = svg.getBoundingClientRect();
    // map client coords → viewBox coords (chart uses preserveAspectRatio="none")
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const py = ((e.clientY - rect.top) / rect.height) * H;
    if (px < PL || px > W - PR || py < PT || py > H - PB) {
      hide();
      return;
    }
    // Snap to the nearest bar. Dot sits on that bar's close so the mark,
    // the vertical line's implied candle, and the tooltip all describe
    // the same data point — no mismatch between what you see and what
    // the tooltip says.
    const rel = Math.max(0, Math.min(1, (px - PL) / plotW));
    const idx = Math.max(0, Math.min(N - 1, Math.round(rel * (N - 1))));
    const k = ohlc[idx];

    // Vertical cursor line follows the raw cursor X (smooth, sub-pixel) so
    // the guide still feels analog even though the dot is bar-snapped.
    cursorX.setAttribute("x1", px);
    cursorX.setAttribute("x2", px);

    // Dot position: bar-snapped. Only re-apply attrs when the bar actually
    // changes — avoids layout thrash when the cursor moves inside one bar.
    if (idx !== lastIdx) {
      lastIdx = idx;
      const bx = toX(idx);
      const by = toY(k.c);
      if (dotHalo) { dotHalo.setAttribute("cx", bx); dotHalo.setAttribute("cy", by); }
      if (dotCore) { dotCore.setAttribute("cx", bx); dotCore.setAttribute("cy", by); }
    }

    // Price-responding colour: green if this bar's close is above the
    // range's first close, red if below. Only write fill when it actually
    // flips so we don't churn the DOM every frame.
    const dotColor = k.c >= ohlc[0].c
      ? "var(--positive, #00B386)"
      : "var(--negative, #EB5757)";
    if (dotColor !== lastColor) {
      lastColor = dotColor;
      if (dotHalo) dotHalo.setAttribute("fill", dotColor);
      if (dotCore) dotCore.setAttribute("fill", dotColor);
    }
    cursor.style.display = "";

    const d = new Date(k.t);
    const dateStr = d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    const fmt = (p) => "₹" + (p / 100).toFixed(2);
    const tipLines = mode === "area"
      ? [
          `<span style="color:var(--text-dim)">${dateStr}</span>`,
          `<strong style="font-size:13px;">${fmt(k.c)}</strong>`,
        ]
      : [
          `<span style="color:var(--text-dim)">${dateStr}</span>`,
          `<span>O <strong>${fmt(k.o)}</strong>  H <strong style="color:var(--positive)">${fmt(k.h)}</strong></span>`,
          `<span>L <strong style="color:var(--negative)">${fmt(k.l)}</strong>  C <strong>${fmt(k.c)}</strong></span>`,
          k.v ? `<span style="color:var(--text-dim)">Vol ${k.v.toLocaleString("en-IN")}</span>` : "",
        ].filter(Boolean);

    tooltip.innerHTML = tipLines.join("<br>");
    tooltip.style.display = "";
    // Position the tooltip next to the cursor — NOT snapped to the bar, so
    // it tracks 1:1 with the pointer. Reading the price never requires the
    // eye to leave the line the user is tracing.
    const containerRect = container.getBoundingClientRect();
    const cursorPxX = e.clientX - containerRect.left;
    const cursorPxY = e.clientY - containerRect.top;
    const tipW = tooltip.offsetWidth || 160;
    const tipH = tooltip.offsetHeight || 60;
    const GAP = 14;
    // Prefer right of cursor; flip left if we'd overflow the container.
    let leftPx = cursorPxX + GAP;
    if (leftPx + tipW > containerRect.width - 4) leftPx = cursorPxX - tipW - GAP;
    if (leftPx < 4) leftPx = 4;
    // Vertically center on cursor; clamp inside container.
    let topPx = cursorPxY - tipH / 2;
    if (topPx < 4) topPx = 4;
    if (topPx + tipH > containerRect.height - 4) topPx = containerRect.height - tipH - 4;
    tooltip.style.left = leftPx + "px";
    tooltip.style.top = topPx + "px";
  }

  function hide() {
    cursor.style.display = "none";
    tooltip.style.display = "none";
    lastIdx = -1;
    lastColor = "";
  }

  container.addEventListener("mousemove", onMove);
  container.addEventListener("mouseleave", hide);
  // Basic touch support (tap to pin)
  container.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (t) onMove({ clientX: t.clientX, clientY: t.clientY });
  }, { passive: true });
  container.addEventListener("touchend", hide);

  return () => {
    container.removeEventListener("mousemove", onMove);
    container.removeEventListener("mouseleave", hide);
  };
}

// ---- AREA CHART (portfolio over time) -----------------------------------
export function areaChart(values, opts = {}) {
  return lineChart(values, { ...opts, areaFill: true });
}

function formatAxisNumber(v) {
  const abs = Math.abs(v);
  // Enough precision that 5 ticks spanning a typical stock-price range never
  // collapse to duplicate labels. Previous rounded-to-"k" logic meant a chart
  // spanning ₹1,267–₹1,612 rendered as "1k, 1k, 1k, 2k, 2k" — unreadable.
  if (abs >= 1e7) return (v / 1e7).toFixed(2) + "Cr";
  if (abs >= 1e5) return (v / 1e5).toFixed(2) + "L";
  if (abs >= 1e4) return (v / 1e3).toFixed(1) + "k";   // 10k–99.9k
  if (abs >= 1e3) return (v / 1e3).toFixed(2) + "k";   // 1.00k–9.99k
  if (abs >= 100) return v.toFixed(0);                  // 100–999
  return v.toFixed(2);                                  // <100
}
