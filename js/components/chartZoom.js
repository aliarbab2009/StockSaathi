// =============================================================================
// CHART ZOOM — pinch / wheel / pan gesture engine for stockChart().
//
// Wraps a chart-host container and emits two callbacks back to the caller:
//   * onCommit({ scale, centerMs, manualPan }) — fired on gesture-end, after
//     the user has settled on a new zoom/pan state. Caller should update
//     its model state and re-render the chart with the new xAxisRange.
//   * onReset() — fired on double-click (desktop) / two-finger-tap (mobile).
//
// Architecture (from the v1 plan's "hybrid" recommendation):
//
//   Layer A  — DURING an active gesture we DO NOT re-render. Instead we
//              apply a CSS transform="translate(tx) scale(sx, 1)" to the
//              <g class="chart-plot-area"> sub-group inside the SVG, via
//              requestAnimationFrame. That keeps gestures buttery at 60 fps
//              even on low-end mobile — re-rendering stockChart() every
//              frame takes >16 ms on a mid-range phone.
//
//   Layer B  — ON gesture-end we clear the transform and call onCommit(…)
//              with the final state. The caller decides whether to refetch
//              finer-granularity data (e.g. 5m → 1m when zoomed past 3×)
//              and re-render.
//
// Crosshair is hidden during active gestures — re-syncing it with a
// transient transform is cheap but visually distracting (the dot would
// stretch horizontally as the chart does). Hide, restore on commit.
//
// MUST stay in sync with stockChart()'s .chart-plot-area + SVG dataset
// contract (data-w, data-pl, data-pr, data-x-from, data-x-to).
// =============================================================================

// Tuning knobs — calibrated against a ThinkPad trackpad + iPhone 12 pinch.
const WHEEL_SENSITIVITY = 0.0015;    // multiplicative zoom per wheel unit
const COMMIT_DEBOUNCE_MS = 120;       // wait this long after last wheel tick
const MIN_SCALE = 1;                  // cannot zoom out past full session
const MAX_SCALE = 8;                  // 8× = ~47 min visible in 6h15m session

/**
 * Attach zoom + pan + reset handlers to a chart container. Returns a cleanup
 * function that removes all listeners.
 *
 * @param {HTMLElement} container       — the #stock-chart-host div
 * @param {object}      opts
 * @param {() => {scale, centerMs, manualPan, fromMs, toMs}} opts.getState
 *        Caller-provided accessor returning the current zoom state + the
 *        FULL session bounds (fromMs, toMs). Must be called per gesture —
 *        state may have changed since last attachment.
 * @param {(next: {scale, centerMs, manualPan}) => void} opts.onCommit
 *        Fired on gesture-end. Receives the new state; caller persists it
 *        and triggers a re-render.
 * @param {() => void} opts.onReset
 *        Fired on double-click / two-finger-tap.
 * @param {(active: boolean) => void} [opts.onGestureActive]
 *        Fired when a gesture starts (true) and ends (false). Used so
 *        refreshHistory can skip rendering mid-gesture.
 */
export function attachChartZoom(container, opts) {
  if (!container) return () => {};
  const svg = container.querySelector(".chart-svg");
  const plotArea = container.querySelector(".chart-plot-area");
  const cursor = container.querySelector(".chart-cursor");
  if (!svg || !plotArea) return () => {};

  const getState = opts.getState || (() => ({ scale: 1, centerMs: null, manualPan: false, fromMs: 0, toMs: 0 }));
  const onCommit = opts.onCommit || (() => {});
  const onReset = opts.onReset || (() => {});
  const setGestureActive = opts.onGestureActive || (() => {});

  // viewBox width (logical, from stockChart's `width` prop). All pixel math
  // goes through this so we stay correct under CSS stretching / high-DPI.
  const W = +svg.dataset.w;
  const PL = +svg.dataset.pl;
  const PR = +svg.dataset.pr;
  const plotW = W - PL - PR;

  // In-flight transient gesture state. Only valid while an action is
  // happening; cleared on commit.
  let gestureLive = null;            // { scale, centerMs, translateVb, scaleFactor }
  let wheelCommitTimer = null;
  let pointerMap = new Map();        // pointerId → { x, y }
  let pinchStart = null;             // { distance, midpointMs, startState }
  let panStart = null;               // { x, startCenterMs }
  let rafPending = false;

  // --- coordinate helpers ----------------------------------------------

  // Client pixel X → viewBox X (mirrors attachStockChartHover's math).
  function clientToVbX(clientX) {
    const rect = svg.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * W;
  }

  // viewBox X → time (ms) on the currently-visible window.
  function vbXToMs(vbX) {
    const s = getState();
    const { scale, centerMs, fromMs, toMs } = s;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return null;
    const totalSpan = toMs - fromMs;
    const span = totalSpan / (scale || 1);
    const center = centerMs ?? (fromMs + totalSpan / 2);
    const vFrom = Math.max(fromMs, center - span / 2);
    const rel = Math.max(0, Math.min(1, (vbX - PL) / plotW));
    return vFrom + rel * span;
  }

  // Clamp a (scale, centerMs) pair to the session window so zoom never
  // slides past 9:15 or 15:30.
  function clampState(scale, centerMs) {
    const { fromMs, toMs } = getState();
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    const totalSpan = toMs - fromMs;
    const span = totalSpan / s;
    let c = centerMs ?? (fromMs + totalSpan / 2);
    if (c - span / 2 < fromMs) c = fromMs + span / 2;
    if (c + span / 2 > toMs)   c = toMs - span / 2;
    return { scale: s, centerMs: c };
  }

  // --- Layer A: transient CSS transform --------------------------------

  // Given a target (scale, centerMs) relative to the CURRENT state, compute
  // the SVG transform that previews the zoom without re-rendering.
  //
  // Idea: the plot currently spans [curFrom, curTo] across [PL, PL+plotW].
  // After commit it will span [tgtFrom, tgtTo] across the same pixel range.
  // The transient transform maps current-pixel-X to target-pixel-X via a
  // translate+scale about the left edge of the plot area.
  function previewTransform(targetScale, targetCenterMs) {
    const s = getState();
    const totalSpan = s.toMs - s.fromMs;
    if (totalSpan <= 0) return "";
    const curSpan = totalSpan / (s.scale || 1);
    const curCenter = s.centerMs ?? (s.fromMs + totalSpan / 2);
    const curFrom = curCenter - curSpan / 2;

    const { scale: tS, centerMs: tC } = clampState(targetScale, targetCenterMs);
    const tgtSpan = totalSpan / tS;
    const tgtFrom = tC - tgtSpan / 2;

    // scale factor: how much to stretch the current view to become the target
    const scaleFactor = curSpan / tgtSpan;
    // pixel offset: where the current view's left edge lands in the target
    const msOffset = curFrom - tgtFrom;
    const pxOffset = (msOffset / tgtSpan) * plotW;

    // Transform origin at (PL, 0) so scale happens about the plot's left edge.
    return `translate(${pxOffset}, 0) scale(${scaleFactor}, 1) translate(${-PL + PL / scaleFactor}, 0)`;
  }

  function applyPreview(targetScale, targetCenterMs) {
    gestureLive = { scale: targetScale, centerMs: targetCenterMs };
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!gestureLive) return;
      plotArea.setAttribute("transform", previewTransform(gestureLive.scale, gestureLive.centerMs));
      if (cursor) cursor.style.display = "none";
    });
  }

  function clearPreview() {
    plotArea.removeAttribute("transform");
  }

  // --- Layer B: commit -------------------------------------------------

  function commitNow(manualPan) {
    if (!gestureLive) return;
    const { scale, centerMs } = clampState(gestureLive.scale, gestureLive.centerMs);
    gestureLive = null;
    clearPreview();
    setGestureActive(false);
    // Only fire commit if anything actually changed vs current state.
    const cur = getState();
    if (cur.scale === scale && cur.centerMs === centerMs && cur.manualPan === manualPan) return;
    onCommit({ scale, centerMs, manualPan });
  }

  // --- Wheel (desktop) --------------------------------------------------

  function onWheel(e) {
    // Preventing default is critical — otherwise the page scrolls instead
    // of the chart zooming. Honour trackpad pinch gestures too (they come
    // through as wheel events with ctrlKey=true on most browsers).
    e.preventDefault();
    e.stopPropagation();
    setGestureActive(true);
    const s = getState();
    const factor = Math.exp(-e.deltaY * WHEEL_SENSITIVITY);
    const curScale = gestureLive?.scale ?? s.scale ?? 1;
    const targetScale = curScale * factor;
    // Zoom around the cursor's timestamp — so the point under the cursor
    // stays put as the chart stretches around it.
    const vbX = clientToVbX(e.clientX);
    const cursorMs = vbXToMs(vbX);
    // New center shifts so cursorMs stays at vbX after the zoom. This
    // creates the TradingView-style "zoom toward cursor" feel.
    const totalSpan = s.toMs - s.fromMs;
    const newSpan = totalSpan / Math.max(MIN_SCALE, Math.min(MAX_SCALE, targetScale));
    const newCenter = cursorMs - (vbX - PL - plotW / 2) * (newSpan / plotW);
    applyPreview(targetScale, newCenter);
    if (wheelCommitTimer) clearTimeout(wheelCommitTimer);
    wheelCommitTimer = setTimeout(() => {
      wheelCommitTimer = null;
      commitNow(s.manualPan);   // wheel-zoom doesn't flip manualPan
    }, COMMIT_DEBOUNCE_MS);
  }

  // --- Pointer / pinch / pan -------------------------------------------

  function distance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }
  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function onPointerDown(e) {
    // Only track primary pointer events coming from within the SVG area.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    container.setPointerCapture?.(e.pointerId);
    pointerMap.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setGestureActive(true);
    if (pointerMap.size === 2) {
      // Pinch begin.
      const [a, b] = [...pointerMap.values()];
      const s = getState();
      const midX = clientToVbX(midpoint(a, b).x);
      const midMs = vbXToMs(midX);
      pinchStart = {
        distance: distance(a, b),
        midpointMs: midMs,
        startScale: s.scale || 1,
        startCenter: s.centerMs ?? ((s.fromMs + s.toMs) / 2),
      };
      panStart = null;   // abandon any in-progress pan
    } else if (pointerMap.size === 1) {
      // Single-pointer drag = pan, but only if already zoomed in.
      const s = getState();
      if ((s.scale || 1) > MIN_SCALE) {
        panStart = {
          x: e.clientX,
          startCenterMs: s.centerMs ?? ((s.fromMs + s.toMs) / 2),
        };
      }
    }
  }

  function onPointerMove(e) {
    if (!pointerMap.has(e.pointerId)) return;
    pointerMap.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointerMap.size >= 2 && pinchStart) {
      // Pinch in-flight.
      const [a, b] = [...pointerMap.values()];
      const d = distance(a, b);
      if (pinchStart.distance > 0) {
        const ratio = d / pinchStart.distance;
        const targetScale = pinchStart.startScale * ratio;
        // Keep the midpoint's time pinned in place as scale changes.
        const s = getState();
        const totalSpan = s.toMs - s.fromMs;
        const newSpan = totalSpan / Math.max(MIN_SCALE, Math.min(MAX_SCALE, targetScale));
        const midVbX = clientToVbX(midpoint(a, b).x);
        const targetCenter = pinchStart.midpointMs - (midVbX - PL - plotW / 2) * (newSpan / plotW);
        applyPreview(targetScale, targetCenter);
      }
      e.preventDefault();
    } else if (pointerMap.size === 1 && panStart) {
      // Pan in-flight.
      const dx = e.clientX - panStart.x;
      const s = getState();
      const rect = svg.getBoundingClientRect();
      const totalSpan = s.toMs - s.fromMs;
      const curSpan = totalSpan / (s.scale || 1);
      const msPerPx = curSpan / ((plotW / W) * rect.width);
      const targetCenter = panStart.startCenterMs - dx * msPerPx;
      applyPreview(s.scale || 1, targetCenter);
      e.preventDefault();
    }
  }

  function onPointerUp(e) {
    container.releasePointerCapture?.(e.pointerId);
    const hadPinch = !!pinchStart && pointerMap.size >= 2;
    const hadPan = !!panStart && pointerMap.size === 1;
    pointerMap.delete(e.pointerId);
    if (pointerMap.size === 0) {
      const s = getState();
      if (hadPinch) {
        // Pinch-end. manualPan stays as-is (pinch zooms, it doesn't pan).
        commitNow(s.manualPan);
      } else if (hadPan) {
        // Pan-end. Mark manualPan=true so sticky-right-edge stops.
        commitNow(true);
      } else {
        // Stray pointer-up with no tracked gesture — just clear state.
        setGestureActive(false);
        clearPreview();
        gestureLive = null;
      }
      pinchStart = null;
      panStart = null;
    } else if (pointerMap.size === 1 && hadPinch) {
      // One finger lifted during pinch → keep the other as a pan base.
      const [remainingId] = pointerMap.keys();
      const remaining = pointerMap.get(remainingId);
      const sNow = getState();
      panStart = {
        x: remaining.x,
        startCenterMs: gestureLive?.centerMs ?? sNow.centerMs ?? ((sNow.fromMs + sNow.toMs) / 2),
      };
      pinchStart = null;
    }
  }

  function onPointerCancel(e) { onPointerUp(e); }

  // --- Reset (double-click / two-finger-tap) ---------------------------

  function onDoubleClick(e) {
    e.preventDefault();
    clearPreview();
    gestureLive = null;
    pinchStart = null;
    panStart = null;
    pointerMap.clear();
    setGestureActive(false);
    onReset();
  }

  // Two-finger-tap = simultaneous 2 pointer-down then 2 pointer-up within
  // 250 ms, with minimal movement. Track via a small state machine.
  let twoFingerTap = null;
  function maybeTwoFingerTapStart() {
    if (pointerMap.size === 2) {
      const [a, b] = [...pointerMap.values()];
      twoFingerTap = { at: Date.now(), ax: a.x, ay: a.y, bx: b.x, by: b.y };
    } else {
      twoFingerTap = null;
    }
  }
  function maybeTwoFingerTapEnd() {
    if (!twoFingerTap) return false;
    if (Date.now() - twoFingerTap.at > 250) return false;
    if (pointerMap.size > 0) return false;
    twoFingerTap = null;
    onReset();
    return true;
  }

  // Wire up --------------------------------------------------------------
  // Wrap onPointerDown / onPointerUp with the two-finger-tap detector.
  // This way each DOM listener has exactly one registration and cleanup
  // stays symmetric.
  const pointerDownWithTap = (e) => { onPointerDown(e); maybeTwoFingerTapStart(); };
  const pointerUpWithTap = (e) => {
    const wasTwoFinger = (pointerMap.size === 2 && twoFingerTap);
    onPointerUp(e);
    if (wasTwoFinger) maybeTwoFingerTapEnd();
  };

  svg.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("pointerdown", pointerDownWithTap);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", pointerUpWithTap);
  container.addEventListener("pointercancel", onPointerCancel);
  svg.addEventListener("dblclick", onDoubleClick);

  return () => {
    svg.removeEventListener("wheel", onWheel);
    container.removeEventListener("pointerdown", pointerDownWithTap);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", pointerUpWithTap);
    container.removeEventListener("pointercancel", onPointerCancel);
    svg.removeEventListener("dblclick", onDoubleClick);
    if (wheelCommitTimer) clearTimeout(wheelCommitTimer);
  };
}

// Exposed as a helper for stockDetail.js to map scale → interval.
export function intervalForScale(scale) {
  if (scale <= 1.5) return "5m";
  if (scale <= 3)   return "2m";
  return "1m";
}
