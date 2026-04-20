// =============================================================================
// CRASH REPLAY — THE WOW MOMENT
// Drag slider across COVID / GFC / Demonetisation. Dual lines (held vs panic-sold)
// animate. Coach narration card fades in at key frames. Offline-safe.
// =============================================================================

import { CRASHES, getCrashById, registerCustomCrash } from "../data/crashes.js";
import { dualLineChart } from "../components/charts.js";
import { formatRupees, formatPct, deltaClass } from "../money.js";
import { coach } from "../coach/orchestrator.js";
import { recordCoachMessage, setState, getState } from "../state.js";
import { navigate } from "../router.js";
import { generateCustomCrash } from "../features/customCrash.js";

export function renderCrashReplay(main, params) {
  const scenarioId = params?.scenario;

  if (!scenarioId) {
    renderSelector(main);
    return;
  }
  const scenario = getCrashById(scenarioId);
  if (!scenario) {
    main.innerHTML = `<div class="empty-state"><span class="emoji">🔍</span><h3>Scenario not found</h3><a href="#/crash-replay" class="btn btn-primary">Back</a></div>`;
    return;
  }
  renderReplay(main, scenario);
}

function renderSelector(main) {
  main.innerHTML = `
    <section class="crash-hero">
      <div style="margin-bottom: var(--sp-3);">
        <span class="pill pill-brand">⏱ Time Travel</span>
      </div>
      <h1 class="tight">Live through a real crash.<br />Without losing a rupee.</h1>
      <p class="muted" style="max-width: 640px; margin: 0 auto; font-size: var(--text-lg);">
        Scrub through real moments of Indian market panic.
        Watch a ₹1,00,000 portfolio split: if you held, vs if you panic-sold on day 3.
      </p>
    </section>

    <div class="card" id="custom-crash-card" style="margin-top: var(--sp-6); margin-bottom: var(--sp-6);">
      <h3 style="margin-bottom: var(--sp-2);">✨ Ask about any Indian market event</h3>
      <p class="muted" style="margin-bottom: var(--sp-3); font-size: var(--text-sm); line-height: 1.6;">
        Harshad Mehta 1992. Satyam scandal. Adani short-seller report. YES Bank 2020. 1MDB-era crypto panic. Anything — specific, niche, white or black money. The coach pulls what it knows, builds a day-by-day replay, and drops you into it.
      </p>
      <div class="flex gap-3 wrap" style="align-items:flex-start;">
        <input id="custom-crash-input" class="input" style="flex:1; min-width: 240px;" type="text" maxlength="200" placeholder="e.g. Harshad Mehta 1992 securities scam" />
        <button id="custom-crash-btn" class="btn btn-primary">Generate replay</button>
      </div>
      <div id="custom-crash-status" class="muted text-xs" style="margin-top: var(--sp-2); min-height: 1.2em;"></div>
    </div>

    <div style="margin-bottom: var(--sp-3);">
      <h3 style="margin: 0;">Curated replays</h3>
      <p class="muted text-sm">Hand-tuned with real historical Nifty values.</p>
    </div>
    <div class="crash-scenarios">
      ${CRASHES.map(c => `
        <button class="crash-scenario" data-id="${c.id}">
          <div class="flex items-center justify-between">
            <h4>${c.title}</h4>
            <span class="pill ${c.finalDelta > 0 ? "pill-green" : "pill-red"}">
              ${c.finalDelta > 0 ? "+" : ""}${c.finalDelta.toFixed(1)}% delta
            </span>
          </div>
          <div class="desc">${c.description}</div>
          <div class="meta">${c.startLabel} → ${c.endLabel}</div>
        </button>
      `).join("")}
    </div>

    <div class="card" style="margin-top: var(--sp-8); text-align: center;">
      <h3 style="margin-bottom: var(--sp-2);">Tip</h3>
      <p class="muted">
        The COVID 2020 replay is the most visceral — 35% drop in 33 days.
        The held portfolio recovers entirely within 5 months. The panic-seller sits on cash for the whole rally.
      </p>
    </div>
  `;

  main.querySelectorAll(".crash-scenario").forEach(btn => {
    btn.addEventListener("click", () => {
      location.hash = "#/crash-replay/" + btn.dataset.id;
    });
  });

  const input = main.querySelector("#custom-crash-input");
  const button = main.querySelector("#custom-crash-btn");
  const status = main.querySelector("#custom-crash-status");

  async function trigger() {
    const q = (input.value || "").trim();
    if (!q) {
      status.textContent = "Type a crash or event to replay.";
      input.focus();
      return;
    }
    button.disabled = true;
    input.disabled = true;
    button.textContent = "Generating…";
    status.textContent = "Gathering historical context and synthesising the day-by-day trajectory. ~8–15 s.";
    try {
      const scenario = await generateCustomCrash(q);
      registerCustomCrash(scenario);
      status.textContent = `Ready — ${scenario.title}. Loading replay…`;
      location.hash = "#/crash-replay/" + scenario.id;
    } catch (e) {
      status.innerHTML = `<span style="color:var(--negative);">Couldn't generate that one — ${escapeHtml(e.message || "unknown error")}. Try a different phrasing, or pick a curated replay below.</span>`;
      button.disabled = false;
      input.disabled = false;
      button.textContent = "Generate replay";
    }
  }

  button.addEventListener("click", trigger);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") trigger(); });
}

function renderReplay(main, scenario) {
  const totalFrames = scenario.frames.length;

  // Interpolate frames to a uniform 0..N index. We use scenario.frames[i].day as
  // "trading day offset" — but the frames array itself already holds every day
  // we want to render.
  const frames = scenario.frames;
  let currentIdx = 0;

  // Derive "mood markers" from frames: pick ~5 interesting moments
  const markers = buildMarkers(scenario);

  main.innerHTML = `
    <div class="replay-topbar">
      <a href="#/crash-replay" class="btn btn-ghost btn-sm">← Scenarios</a>
      <div class="replay-title-inline">
        <span class="pill pill-brand">⏱ ${scenario.id.replace(/_/g, " ")}</span>
        <strong>${scenario.title}</strong>
        <span class="mood-indicator calm" id="mood-indicator">🧘 Calm</span>
      </div>
      <div class="replay-controls replay-controls-top">
        <button class="btn btn-primary btn-sm" id="play-btn">▶ Play (15s)</button>
        <button class="btn btn-ghost btn-sm" id="play-slow-btn">🐢 Slow</button>
        <button class="btn btn-ghost btn-sm" id="reset-btn">⟲ Reset</button>
        <button class="btn btn-ghost btn-sm" id="jump-bottom-btn">📉 Bottom</button>
        <button class="btn btn-ghost btn-sm" id="jump-end-btn">⏭ End</button>
      </div>
    </div>

    <div class="replay-panel">
      <div class="replay-stats">
        <div class="replay-stat held">
          <div class="header"><span>● If you held</span><span class="dim" id="held-days-label">Day 0</span></div>
          <div class="big tabular" id="held-val">₹1,00,000</div>
          <div class="delta tabular" id="held-delta">+0.00%</div>
        </div>
        <div class="replay-stat panic">
          <div class="header"><span>● If you panic-sold on day 3</span><span class="dim">Locked at day 3</span></div>
          <div class="big tabular" id="panic-val">₹1,00,000</div>
          <div class="delta tabular" id="panic-delta">+0.00%</div>
        </div>
      </div>

      <div class="replay-slider-wrap">
        <div class="replay-slider-meta">
          <span>${scenario.startLabel}</span>
          <span id="slider-pos">Day 0</span>
          <span>${scenario.endLabel}</span>
        </div>
        <div class="replay-markers" id="markers-wrap">
          ${markers.map(mk => `
            <button class="replay-marker" data-idx="${mk.idx}" title="${escapeAttr(mk.label)}" style="left: ${(mk.idx / (totalFrames - 1)) * 100}%;">
              ${escapeHtml(mk.short)}
            </button>
          `).join("")}
        </div>
        <input type="range" min="0" max="${totalFrames - 1}" value="0" class="replay-slider" id="scrubber" step="1" aria-label="Time travel scrubber" />
      </div>

      <div style="height: 340px; margin: var(--sp-4) 0 0;" id="replay-chart"></div>

      <div class="replay-narration" id="narration">
        ${escapeHtml(scenario.narrations[frames[0].n] || "Move the slider or click a date marker to begin.")}
      </div>

      <div id="dynamic-callout"></div>

      <div id="final-banner" style="display: none;">
        <div class="replay-final-banner">
          <div>${scenario.finalDelta > 0 ? "Holding outperformed panic-selling by" : "Panic-seller came out ahead by"}</div>
          <span class="num tabular">${Math.abs(scenario.finalDelta).toFixed(1)}%</span>
          <div style="font-size: var(--text-sm); font-weight: 500; margin-top: var(--sp-2); opacity: 0.9;">
            Index dropped ${Math.abs(scenario.indexDrop)}% at its worst · Recovery took ${scenario.recoveryDays} trading days
          </div>
        </div>
      </div>
    </div>

    <details class="replay-context-details">
      <summary class="muted">What this scenario is</summary>
      <p class="muted" style="margin-top: var(--sp-3); font-size: var(--text-base); line-height: 1.6;">${scenario.description}</p>
    </details>

    <div class="grid" style="grid-template-columns: 1fr 1fr; gap: var(--sp-4); margin-top: var(--sp-6);">
      <div class="card">
        <h4 style="font-size: var(--text-sm); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">What this replay holds constant</h4>
        <ul style="margin-top: var(--sp-3); color: var(--text); line-height: 1.7; font-size: var(--text-sm); padding-left: 18px;">
          <li>A ₹1,00,000 portfolio across 5 diversified Indian large-caps</li>
          <li>The panic-sold line assumes sell-everything on day 3, then stay in cash</li>
          <li>Prices are real historical close values from the actual crash window</li>
          <li>No brokerage or tax drag applied (would widen the held advantage further)</li>
        </ul>
      </div>
      <div class="card">
        <h4 style="font-size: var(--text-sm); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;">What this replay teaches</h4>
        <p style="margin-top: var(--sp-3); color: var(--text); line-height: 1.7; font-size: var(--text-sm);">
          The held investor doesn't "beat the crash" — they survive it.
          The panic-seller crystallises a paper loss into a real one and then waits for "the right moment" to re-enter. That moment almost never comes cheaper than where they sold.
        </p>
      </div>
    </div>
  `;

  const scrubber = main.querySelector("#scrubber");
  const sliderPos = main.querySelector("#slider-pos");
  const heldVal = main.querySelector("#held-val");
  const panicVal = main.querySelector("#panic-val");
  const heldDelta = main.querySelector("#held-delta");
  const panicDelta = main.querySelector("#panic-delta");
  const heldDaysLabel = main.querySelector("#held-days-label");
  const narration = main.querySelector("#narration");
  const finalBanner = main.querySelector("#final-banner");
  const chartRoot = main.querySelector("#replay-chart");
  const playBtn = main.querySelector("#play-btn");
  const playSlowBtn = main.querySelector("#play-slow-btn");
  const resetBtn = main.querySelector("#reset-btn");
  const jumpEndBtn = main.querySelector("#jump-end-btn");
  const jumpBottomBtn = main.querySelector("#jump-bottom-btn");
  const moodEl = main.querySelector("#mood-indicator");
  const calloutEl = main.querySelector("#dynamic-callout");

  // Pre-fire the CRASH_SIMULATION_START coach message once
  const state = getState();
  const already = state.coachMessages.some(m => m.eventType === "CRASH_SIMULATION_START" && m.triggerSymbol === scenario.id);
  if (!already) {
    coach({ type: "CRASH_SIMULATION_START", symbol: scenario.id, days: frames.length }).then(msg => {
      msg.triggerSymbol = scenario.id;
      recordCoachMessage(msg);
    });
  }

  let lastNarrationKey = null;
  let playHandle = null;

  function renderAt(idx) {
    currentIdx = Math.max(0, Math.min(frames.length - 1, idx));
    const f = frames[currentIdx];
    const startHeld = frames[0].held;
    const startPanic = frames[0].panic;

    // Update counters (animate last digits via data-atts)
    heldVal.textContent = "₹" + indianNumber(f.held);
    panicVal.textContent = "₹" + indianNumber(f.panic);

    const hd = (f.held - startHeld) / startHeld;
    const pd = (f.panic - startPanic) / startPanic;
    heldDelta.textContent = (hd > 0 ? "+" : "") + (hd * 100).toFixed(1) + "%";
    panicDelta.textContent = (pd > 0 ? "+" : "") + (pd * 100).toFixed(1) + "%";

    heldDaysLabel.textContent = `Day ${f.day}`;
    sliderPos.textContent = `Day ${f.day}`;

    // Apply colors to deltas
    heldDelta.className = "delta tabular " + (hd > 0 ? "up" : hd < 0 ? "down" : "");
    panicDelta.className = "delta tabular " + (pd > 0 ? "up" : pd < 0 ? "down" : "");

    // Narration (only when key changes)
    const activeNarKey = pickActiveNarration(frames, currentIdx);
    if (activeNarKey !== lastNarrationKey) {
      narration.classList.add("fading");
      setTimeout(() => {
        narration.textContent = scenario.narrations[activeNarKey] || "";
        narration.classList.remove("fading");
      }, 150);
      lastNarrationKey = activeNarKey;
    }

    // Chart — we supply interpolated series up to currentIdx full range
    const heldSeries = frames.map(f => f.held);
    const panicSeries = frames.map(f => f.panic);
    chartRoot.innerHTML = dualLineChart({
      held: heldSeries, panic: panicSeries, height: 340, width: 900, currentIndex: currentIdx,
    });

    // Show final banner at end
    finalBanner.style.display = currentIdx >= frames.length - 1 ? "" : "none";

    // Mood meter — based on current drawdown from start
    const drawdownPct = (f.held - startHeld) / startHeld;
    const mood = drawdownPct >= 0.05 ? { cls: "euphoric", label: "🎉 Euphoric" }
               : drawdownPct >= -0.03 ? { cls: "calm", label: "🧘 Calm" }
               : drawdownPct >= -0.12 ? { cls: "nervous", label: "😰 Nervous" }
               : { cls: "panic", label: "😱 Peak panic" };
    if (moodEl) {
      moodEl.className = "mood-indicator " + mood.cls;
      moodEl.textContent = mood.label;
    }

    // Dynamic callouts at key thresholds
    if (calloutEl) {
      const callouts = [];
      if (drawdownPct <= -0.10 && drawdownPct > -0.20) {
        callouts.push(`<div class="replay-callout"><strong>−10% mark.</strong> Most people start googling "is the market crashing?" here. Heart-rate up. But historically, this is still the normal-correction zone — happens ~1-2 times a year.</div>`);
      } else if (drawdownPct <= -0.20 && drawdownPct > -0.30) {
        callouts.push(`<div class="replay-callout"><strong>−20% — bear market territory.</strong> This is where most retail panic-selling happens. The discomfort is real. But recovery data says: the bigger the drop, the faster (and larger) the eventual bounce tends to be.</div>`);
      } else if (drawdownPct <= -0.30) {
        callouts.push(`<div class="replay-callout"><strong>−30%+ drawdown.</strong> You're looking at a generational buying opportunity — but it won't feel like one. It'll feel like the world is ending. Every single time in history, it wasn't.</div>`);
      } else if (drawdownPct >= 0.05 && currentIdx > frames.length / 2) {
        callouts.push(`<div class="replay-callout"><strong>Back above start.</strong> Notice the gap between the green and red lines — that's the cost of the day-3 panic. You can't re-live it, but you can learn from it.</div>`);
      }
      calloutEl.innerHTML = callouts.join("");
    }

    // Active marker
    const markersWrap = main.querySelector("#markers-wrap");
    if (markersWrap) {
      markersWrap.querySelectorAll(".replay-marker").forEach(mk => {
        const d = parseInt(mk.dataset.idx, 10);
        mk.classList.toggle("active", Math.abs(d - currentIdx) <= 1);
      });
    }
  }

  renderAt(0);

  scrubber.addEventListener("input", (e) => {
    const idx = parseInt(e.target.value, 10);
    renderAt(idx);
    stopPlayback();
  });

  resetBtn.addEventListener("click", () => {
    stopPlayback();
    scrubber.value = "0";
    renderAt(0);
  });
  jumpEndBtn.addEventListener("click", () => {
    stopPlayback();
    scrubber.value = String(frames.length - 1);
    renderAt(frames.length - 1);
    fireEndMessage();
  });
  function startPlayback(durationMs, btnEl) {
    if (playHandle) { stopPlayback(); return; }
    const startTime = performance.now();
    if (btnEl) btnEl.textContent = "⏸ Pause";
    function step(now) {
      const elapsed = now - startTime;
      const pct = Math.min(1, elapsed / durationMs);
      const idx = Math.floor(pct * (frames.length - 1));
      scrubber.value = String(idx);
      renderAt(idx);
      if (pct < 1) playHandle = requestAnimationFrame(step);
      else { stopPlayback(); fireEndMessage(); }
    }
    playHandle = requestAnimationFrame(step);
  }

  playBtn.addEventListener("click", () => startPlayback(15000, playBtn));
  playSlowBtn?.addEventListener("click", () => startPlayback(30000, playSlowBtn));
  jumpBottomBtn?.addEventListener("click", () => {
    stopPlayback();
    // Jump to the lowest held value frame
    let minIdx = 0, minVal = Infinity;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].held < minVal) { minVal = frames[i].held; minIdx = i; }
    }
    scrubber.value = String(minIdx);
    renderAt(minIdx);
  });

  // Marker clicks
  main.querySelectorAll(".replay-marker").forEach(mk => {
    mk.addEventListener("click", () => {
      const idx = parseInt(mk.dataset.idx, 10);
      stopPlayback();
      scrubber.value = String(idx);
      renderAt(idx);
    });
  });

  function stopPlayback() {
    if (playHandle) {
      cancelAnimationFrame(playHandle);
      playHandle = null;
      playBtn.textContent = "▶ Auto-play (15s)";
      if (playSlowBtn) playSlowBtn.textContent = "🐢 Slow (30s)";
    }
  }

  let endFired = false;
  function fireEndMessage() {
    if (endFired) return;
    endFired = true;
    // Mark completed
    setState(s => ({
      ...s,
      demo: {
        ...s.demo,
        crashReplayCompleted: s.demo.crashReplayCompleted.includes(scenario.id)
          ? s.demo.crashReplayCompleted
          : [...s.demo.crashReplayCompleted, scenario.id],
      },
    }));
    coach({
      type: "CRASH_SIMULATION_END",
      symbol: scenario.id,
      heldBeat: scenario.finalDelta > 0,
      delta: scenario.finalDelta,
      crashTitle: scenario.title,
      indexDrop: `${scenario.indexDrop}%`,
      recoveryDays: scenario.recoveryDays,
    }).then(msg => {
      msg.triggerSymbol = scenario.id;
      recordCoachMessage(msg);
    });
  }

  // Cleanup when leaving page
  const cleanup = () => {
    stopPlayback();
    window.removeEventListener("hashchange", cleanup);
  };
  window.addEventListener("hashchange", cleanup, { once: true });
}

function pickActiveNarration(frames, idx) {
  for (let i = idx; i >= 0; i--) {
    if (frames[i].n) return frames[i].n;
  }
  return null;
}

function buildMarkers(scenario) {
  const frames = scenario.frames;
  const markers = [];
  // Start
  markers.push({ idx: 0, short: "Start", label: scenario.startLabel });
  // Bottom (lowest held value)
  let minIdx = 0, minVal = Infinity;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].held < minVal) { minVal = frames[i].held; minIdx = i; }
  }
  if (minIdx > 0 && minIdx < frames.length - 1) {
    markers.push({ idx: minIdx, short: "Bottom", label: `Lowest point — day ${frames[minIdx].day}` });
  }
  // A mid-point between start and bottom (the "peak panic" moment)
  if (minIdx > 4) {
    const midPanicIdx = Math.floor(minIdx * 0.75);
    markers.push({ idx: midPanicIdx, short: "−20%", label: "Peak retail panic zone" });
  }
  // Recovery marker — first frame after bottom that's materially higher
  for (let i = minIdx + 1; i < frames.length; i++) {
    if (frames[i].held > frames[minIdx].held * 1.08) {
      markers.push({ idx: i, short: "Recovery", label: "+8% off the low — trend shift" });
      break;
    }
  }
  // End
  markers.push({ idx: frames.length - 1, short: "End", label: scenario.endLabel });
  // Dedupe + sort
  const seen = new Set();
  return markers.filter(m => {
    if (seen.has(m.idx)) return false;
    seen.add(m.idx);
    return true;
  }).sort((a, b) => a.idx - b.idx);
}

function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

function indianNumber(n) {
  if (n == null) return "0";
  const abs = Math.abs(Math.round(n));
  const sign = n < 0 ? "-" : "";
  if (abs < 1000) return sign + abs.toString();
  const str = String(abs);
  const last3 = str.slice(-3);
  const rest = str.slice(0, -3);
  return sign + rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
}
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}
