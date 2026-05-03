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

// Featured replays — canonical phrasings that scripts/pregen-crashes.mjs
// has populated into the cross-user cache. Clicking any of these calls
// generateCustomCrash with the exact phrasing → cache hit → instant
// load. MUST stay in sync with EVENTS in scripts/pregen-crashes.mjs.
// If pregen hasn't run yet, the click still works but pays full
// generation cost on first user.
const FEATURED_PHRASINGS = [
  { phrase: "Harshad Mehta 1992",            blurb: "Bombay's first big stock-broker scam — Sensex doubled then halved.", range: "Apr 1992 → Aug 1992" },
  { phrase: "Dot Com 2000",                  blurb: "Indian IT pulled into the global tech bust.",                          range: "Mar 2000 → Jun 2000" },
  { phrase: "Global Financial Crisis 2008",  blurb: "Lehman → Nifty fell 60% over six months.",                             range: "Sep 2008 → Mar 2009" },
  { phrase: "Satyam scandal 2009",           blurb: "Ramalinga Raju's confession letter, IT sector circuit-breakers.",     range: "Jan 2009 → Apr 2009" },
  { phrase: "IL&FS collapse 2018",           blurb: "AAA-rated NBFC defaults trigger a credit-market freeze.",              range: "Sep 2018 → Jan 2019" },
  { phrase: "DHFL crisis 2019",              blurb: "Housing finance giant unravels live.",                                  range: "Jun 2019 → Dec 2019" },
  { phrase: "YES Bank moratorium 2020",      blurb: "RBI freezes withdrawals, retail equity-holder gets wiped to ₹0.",     range: "Mar 2020 → Jul 2020" },
  { phrase: "COVID March 2020",              blurb: "Fastest 35% drop in Nifty history. Recovered in 5 months.",            range: "Feb 2020 → Aug 2020" },
  { phrase: "Paytm IPO Nov 2021",            blurb: "Listed at ₹2150, fell 27% on debut day. Six months in: -75%.",        range: "Nov 2021 → Apr 2022" },
  { phrase: "Adani Hindenburg Jan 2023",     blurb: "Short-seller report wipes ₹10 lakh crore from group market cap.",     range: "Jan 2023 → Jun 2023" },
];

// Hotfix45b: post-process narration text to fix common LLM mis-phrasings.
// Today's known issue: the LLM sometimes writes 'opens at â‚¹X' when the
// startIndex/troughIndex/endIndex values are CLOSING prices (closes[0]
// from Yahoo's daily series). For after-hours news events (RBI moratorium,
// regulatory bans, results announcements) the day-0 price is the LAST CLOSE
// before the news â€” not an open. Fix by rewriting these patterns at
// display time so already-cached scenarios get the correct wording without
// regenerating (LLM tokens, latency).
function sanitizeNarration(text) {
  if (!text || typeof text !== "string") return text;
  return text
    // 'opens at â‚¹X' / 'opens at Rs X' / 'opens at 36.80'  -> 'closes at â‚¹X'
    .replace(/\bopens\s+at\b/gi, "closes at")
    .replace(/\bopened\s+at\b/gi, "closed at")
    .replace(/\bopening\s+(price|level)\s+(of\s+)?/gi, "closing $1 $2")
    // 'opens to â‚¹X' (less common but appears) -> 'closes at â‚¹X'
    .replace(/\bopens\s+to\b/gi, "closes at")
    // 'on the open' / 'at the open' -> 'on the close' / 'at the close'
    .replace(/\b(at|on)\s+the\s+open\b/gi, "$1 the close");
}

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
      <div id="custom-crash-suggestions" class="custom-crash-suggestions"></div>
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

    <div style="margin-top: var(--sp-6); margin-bottom: var(--sp-3);">
      <h3 style="margin: 0;">Featured replays</h3>
      <p class="muted text-sm">Pre-generated for instant load. Real Yahoo data, AI-built narration.</p>
    </div>
    <div class="crash-scenarios" id="featured-replays">
      ${FEATURED_PHRASINGS.map(p => `
        <button class="crash-scenario" data-featured="${escapeAttr(p.phrase)}">
          <div class="flex items-center justify-between">
            <h4>${escapeHtml(p.phrase)}</h4>
            <span class="pill pill-brand">⚡ instant</span>
          </div>
          <div class="desc">${escapeHtml(p.blurb)}</div>
          <div class="meta">${escapeHtml(p.range)}</div>
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

  main.querySelectorAll(".crash-scenario[data-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      location.hash = "#/crash-replay/" + btn.dataset.id;
    });
  });

  const input = main.querySelector("#custom-crash-input");
  const button = main.querySelector("#custom-crash-btn");
  const status = main.querySelector("#custom-crash-status");

  // Featured-replay click → run the same generateCustomCrash flow as
  // typing the phrase manually. Cache-hit when scripts/pregen-crashes.mjs
  // has populated the row; falls back to live generation otherwise.
  main.querySelectorAll(".crash-scenario[data-featured]").forEach(btn => {
    btn.addEventListener("click", () => {
      input.value = btn.dataset.featured;
      trigger();
    });
  });

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
      const msg = String(e?.message || "unknown error");
      // Route quota / key errors straight through so the guidance survives.
      // For anything else, soften with a rephrase hint.
      const isAuthIssue = /quota|key|rate-?limit/i.test(msg);
      const extra = isAuthIssue ? "" : " Try a different phrasing, or pick a curated replay below.";
      status.innerHTML = `<span style="color:var(--negative);">${escapeHtml(msg)}${escapeHtml(extra)}</span>`;
      button.disabled = false;
      input.disabled = false;
      button.textContent = "Generate replay";
    }
  }

  button.addEventListener("click", trigger);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") trigger(); });

  // Populate AI-generated suggestion chips. One LLM call per week for the
  // whole site — cached server-side.
  const suggHost = main.querySelector("#custom-crash-suggestions");
  fetch("/api/ai?op=crash-suggestions").then(r => r.ok ? r.json() : null).then(d => {
    if (!d?.suggestions?.length || !suggHost) return;
    suggHost.innerHTML = d.suggestions.slice(0, 8).map(s =>
      `<button class="crash-sugg-chip" data-sugg="${escapeAttr(s)}">${escapeHtml(s)}</button>`
    ).join("");
    suggHost.querySelectorAll("[data-sugg]").forEach(chip => {
      chip.addEventListener("click", () => {
        input.value = chip.dataset.sugg;
        input.focus();
      });
    });
    // Also rotate through as placeholder text every 4s until the user types.
    let i = 0;
    const rotate = () => {
      if (input.value) return;
      input.placeholder = "e.g. " + d.suggestions[i % d.suggestions.length];
      i++;
    };
    rotate();
    const h = setInterval(rotate, 4000);
    window.addEventListener("hashchange", () => clearInterval(h), { once: true });
  }).catch(() => {});
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
        ${escapeHtml(sanitizeNarration(scenario.narrations[frames[0].n]) || "Move the slider or click a date marker to begin.")}
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

    <details class="replay-context-details" open>
      <summary>What this scenario is</summary>
      <div class="replay-context-body">
        ${renderDescriptionParagraphs(scenario.description)}
        ${scenario.indexDrop != null ? `<div class="replay-context-stats">
          <div><span class="rc-key">Peak drop</span><span class="rc-val negative">${Math.abs(scenario.indexDrop).toFixed(1)}%</span></div>
          <div><span class="rc-key">Recovery</span><span class="rc-val">${scenario.recoveryDays ? scenario.recoveryDays + " trading days" : "within the plotted window"}</span></div>
          <div><span class="rc-key">Window</span><span class="rc-val">${escapeHtml(scenario.startLabel)} → ${escapeHtml(scenario.endLabel)}</span></div>
          <div><span class="rc-key">Held vs panic delta</span><span class="rc-val ${scenario.finalDelta >= 0 ? "positive" : "negative"}">${scenario.finalDelta >= 0 ? "+" : ""}${scenario.finalDelta.toFixed(1)}%</span></div>
        </div>` : ""}
        ${renderKeyMomentsTimeline(scenario)}
      </div>
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
        narration.textContent = sanitizeNarration(scenario.narrations[activeNarKey]) || "";
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

// Render description as separate <p> tags on blank-line / double-newline
// paragraph breaks. Tolerates single-paragraph inputs too.
function renderDescriptionParagraphs(desc) {
  const s = String(desc || "").trim();
  if (!s) return "";
  const paragraphs = s.split(/\n\s*\n|\.\s+(?=[A-Z])/).reduce((acc, chunk, i, arr) => {
    // We split on period-then-capital to catch prose that uses single newlines.
    // Re-attach the trailing period we consumed in the split, but only when the
    // next chunk starts with a capital.
    if (i === arr.length - 1) acc.push(chunk);
    else acc.push(chunk.endsWith(".") || chunk.endsWith("!") || chunk.endsWith("?") ? chunk : chunk + ".");
    return acc;
  }, []);
  // Merge short fragments to keep paragraphs meaningful (>= 3 sentences each).
  const merged = [];
  let buf = "";
  for (const p of paragraphs) {
    buf = buf ? buf + " " + p : p;
    if (buf.split(/[.!?]\s/).length >= 3) {
      merged.push(buf);
      buf = "";
    }
  }
  if (buf) {
    if (merged.length === 0) merged.push(buf);
    else merged[merged.length - 1] += " " + buf;
  }
  return merged.map(p => `<p class="replay-context-para">${escapeHtml(p.trim())}</p>`).join("");
}

// Render the scenario's key moments as a mini timeline beneath the prose.
function renderKeyMomentsTimeline(scenario) {
  const frames = scenario.frames || [];
  if (!frames.length) return "";
  // A key moment is any frame carrying an `n` (narration id)
  const moments = frames
    .filter(f => f.n && scenario.narrations?.[f.n])
    .map(f => ({
      day: f.day,
      narration: sanitizeNarration(scenario.narrations[f.n]),
      heldDelta: (f.held - frames[0].held) / frames[0].held,
    }));
  if (!moments.length) return "";
  return `
    <div class="replay-timeline">
      <div class="replay-timeline-head">Key moments in this replay</div>
      ${moments.map(m => `
        <div class="replay-timeline-row">
          <div class="replay-timeline-day">Day ${m.day}${m.heldDelta !== 0 ? ` · <span class="${m.heldDelta >= 0 ? "positive" : "negative"}">${m.heldDelta >= 0 ? "+" : ""}${(m.heldDelta * 100).toFixed(1)}%</span>` : ""}</div>
          <div class="replay-timeline-body">${escapeHtml(m.narration)}</div>
        </div>
      `).join("")}
    </div>
  `;
}

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
