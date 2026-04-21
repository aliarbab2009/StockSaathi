// =============================================================================
// CUSTOM CRASH GENERATOR
//
// Takes a free-text description of an Indian market event ("Harshad Mehta
// 1992", "Satyam scandal", "YES Bank 2020", etc.) and returns a full CRASH
// scenario object compatible with the existing replay UI.
//
// The LLM returns METADATA only (start/trough/end index levels, duration,
// drop %, named moments). We synthesise the day-by-day frame trajectory
// client-side with a realistic piecewise curve — this keeps the LLM call
// small (fits in the 800-token cap) and the output shape deterministic.
//
// Retries up to 3 times with rising temperature; each attempt runs the
// returned JSON through a shape validator before accepting.
// =============================================================================

const SYSTEM_PROMPT = `You are a financial-history data extractor. Given a description of a DOWNWARD market event (crash, correction, scam, regulatory shock, panic — specifically anything where Indian equities FELL), return a single JSON object.

IMPORTANT — REJECT non-crashes:
If the user described a BULL RUN, RALLY, SURGE, BOOM, IPO pop, positive news, or any event where the market went UP, return:
  { "error": "not_a_crash", "message": "<one short sentence explaining that the replay tool is for drops, and suggesting a comparable crash: e.g. 'Diwali 2008 correction' instead of 'Diwali rally'>" }

Also return the same error for events with drops smaller than 3% (too small to be instructive).

If it IS a genuine crash/drop, return a JSON object with this EXACT shape:

{
  "title": "<short event name, ≤ 50 chars>",
  "startLabel": "<human-readable start date, e.g. 'Mar 11, 2020'>",
  "endLabel": "<human-readable end date>",
  "description": "<rich 120-220 word explanation in 2-3 paragraphs: what was happening in India at the time, what actually triggered the market move, how retail investors experienced it, what the recovery path looked like. Neutral prose, no opinion, no buy/sell advice. First paragraph sets the scene; second paragraph narrates the event; third (if needed) tracks the aftermath.>",
  "totalDays": <integer 20..120, trading days in the window>,
  "startIndex": <number, Nifty/Sensex level at day 0>,
  "troughIndex": <number, lowest level reached>,
  "troughDay": <integer, day offset of trough from day 0>,
  "endIndex": <number, index level at end of window>,
  "indexDrop": <negative number, the % drop from start to trough>,
  "recoveryDays": <integer, trading days from trough to a new all-time high within the event; 0 if the index didn't recover within the plotted window>,
  "panicDay": <integer, when the panic-seller would exit — typically 3>,
  "keyMoments": [
    { "day": <integer>, "label": "<≤ 24 char tag for slider marker>", "narration": "<1-2 sentence narration shown in the replay>" },
    ...
  ]
}

Rules:
- Return ONLY the JSON object. No prose, no code fences, no commentary.
- All numbers are plain JSON numbers, not strings.
- troughDay MUST be between 1 and totalDays-1.
- startIndex and endIndex must be positive.
- troughIndex must be lower than startIndex.
- Include 4 to 7 keyMoments covering: start context, first panic, trough, any mid-course inflection, recovery or finish.
- If you truly don't know the event, make your best reasoned estimate based on the described type of event — do NOT refuse. The user knows output is estimated.`;

const MAX_DAYS = 140;

// Each attempt tuple is [profile, temperature]. We try the fast lane twice
// so most queries land in ~1 s flat; if Flash's JSON fails validation both
// times (rare — mostly niche or badly-worded queries), we escalate to the
// reasoning lane where GPT / Gemini Pro take over. Smart-as-fuck on the
// rare miss, blazing on the common case.
const ATTEMPTS = [
  { profile: "fast",      temperature: 0.2  },
  { profile: "fast",      temperature: 0.55 },
  { profile: "reasoning", temperature: 0.3  },
];

// Normalised query key used for dedup lookup + as a stable alias that points
// at whichever scenario id was generated for this query first.
function queryKey(desc) {
  return String(desc || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").slice(0, 100);
}

const QUERY_INDEX_STORAGE_KEY = "ss.customCrashes.queryIndex.v1";
function queryIndex() {
  try { return JSON.parse(localStorage.getItem(QUERY_INDEX_STORAGE_KEY) || "{}") || {}; }
  catch { return {}; }
}
function rememberQuery(key, scenarioId) {
  try {
    const idx = queryIndex();
    idx[key] = scenarioId;
    localStorage.setItem(QUERY_INDEX_STORAGE_KEY, JSON.stringify(idx));
  } catch {}
}

// Public: return scenario id for a query string if we've generated one before
// AND it still exists in the custom-crash cache. Lets the UI avoid calling
// the LLM twice for the same user query.
export function existingScenarioForQuery(description) {
  const key = queryKey(description);
  if (!key) return null;
  const id = queryIndex()[key];
  if (!id) return null;
  try {
    const all = JSON.parse(localStorage.getItem("ss.customCrashes.v1") || "{}");
    return all[id] ? id : null;
  } catch { return null; }
}

export async function generateCustomCrash(description) {
  // Dedup: already generated? Reuse.
  const cachedId = existingScenarioForQuery(description);
  if (cachedId) {
    try {
      const all = JSON.parse(localStorage.getItem("ss.customCrashes.v1") || "{}");
      if (all[cachedId]) return all[cachedId];
    } catch {}
  }

  let lastErr = null;
  for (const { profile, temperature } of ATTEMPTS) {
    try {
      const meta = await callLlmForMeta(description, temperature, profile);
      // LLM may refuse non-crash queries (rallies, tiny moves) — surface cleanly.
      if (meta && meta.error === "not_a_crash") {
        const msg = typeof meta.message === "string" && meta.message.trim()
          ? meta.message.trim()
          : "That event was a rally, not a crash. The time-travel replay is built for market drops — try something like 'Diwali 2008 correction' instead.";
        const err = new Error(msg);
        err.kind = "not_a_crash";
        throw err;
      }
      reshape(meta);
      const valid = validate(meta);
      if (!valid.ok) { lastErr = valid.error; continue; }
      const scenario = buildScenario(meta);
      rememberQuery(queryKey(description), scenario.id);
      return scenario;
    } catch (e) {
      if (e?.kind === "not_a_crash") throw e;   // don't retry on a deliberate refusal
      lastErr = e?.message || String(e);
    }
  }
  throw new Error(lastErr || "The coach couldn't build that one. Try rephrasing.");
}

// Mutate the raw LLM output into something the validator/builder can
// accept. LLMs tend to describe long-arc events with key moments that
// overflow the day window they pick — rather than reject, grow the
// window to fit the story (within our 140-day cap).
function reshape(m) {
  if (!m || typeof m !== "object") return;
  if (Array.isArray(m.keyMoments)) {
    let maxDay = 0;
    for (const km of m.keyMoments) {
      if (km && typeof km.day === "number" && km.day > maxDay) maxDay = km.day;
    }
    if (maxDay >= (m.totalDays ?? 0)) {
      m.totalDays = Math.min(MAX_DAYS, Math.max(m.totalDays || 0, maxDay + 3));
    }
  }
  if (typeof m.totalDays === "number") {
    m.totalDays = Math.max(10, Math.min(MAX_DAYS, Math.floor(m.totalDays)));
  }
  if (typeof m.troughDay === "number" && typeof m.totalDays === "number") {
    m.troughDay = Math.max(1, Math.min(m.totalDays - 1, Math.floor(m.troughDay)));
  }
}

async function callLlmForMeta(description, temperature, profile) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: String(description).trim().slice(0, 800) },
      ],
      temperature,
      max_tokens: 800,
      response_format: { type: "json_object" },
      profile,
    }),
  });
  if (!res.ok) {
    // Translate HTTP failures into user-facing, jargon-free messages.
    // The UI never mentions API, keys, tokens, settings, or providers —
    // the user should never think about infrastructure.
    if (res.status === 429) {
      throw new Error("The coach is a bit overloaded right now. Try again in a few minutes, or pick one of the curated replays below.");
    }
    if (res.status === 403) {
      throw new Error("Couldn't reach the coach from this page. Try refreshing.");
    }
    if (res.status >= 500) {
      throw new Error("The coach hiccuped on our side. Try again in a moment.");
    }
    throw new Error("The coach couldn't build that one. Try a different phrasing or a curated replay.");
  }
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error("The coach returned an empty answer. Try again.");
  let meta;
  try { meta = JSON.parse(text); }
  catch { throw new Error("The coach's answer didn't parse cleanly. Try again or rephrase."); }
  return meta;
}

function validate(m) {
  if (!m || typeof m !== "object") return { ok: false, error: "not an object" };
  const must = ["title", "startLabel", "endLabel", "description", "totalDays",
                "startIndex", "troughIndex", "troughDay", "endIndex", "indexDrop",
                "recoveryDays", "panicDay", "keyMoments"];
  for (const k of must) if (m[k] == null) return { ok: false, error: `missing ${k}` };
  const n = (v) => typeof v === "number" && Number.isFinite(v);
  if (!n(m.totalDays) || m.totalDays < 10 || m.totalDays > MAX_DAYS)
    return { ok: false, error: "totalDays out of [10,140]" };
  if (!n(m.startIndex) || m.startIndex <= 0) return { ok: false, error: "bad startIndex" };
  if (!n(m.troughIndex) || m.troughIndex <= 0) return { ok: false, error: "bad troughIndex" };
  if (!n(m.endIndex) || m.endIndex <= 0) return { ok: false, error: "bad endIndex" };
  if (m.troughIndex >= m.startIndex) return { ok: false, error: "trough must be below start" };
  if (!n(m.troughDay) || m.troughDay < 1 || m.troughDay >= m.totalDays)
    return { ok: false, error: "troughDay out of range" };
  if (!n(m.indexDrop) || m.indexDrop >= 0 || m.indexDrop < -95)
    return { ok: false, error: "bad indexDrop" };
  if (!Array.isArray(m.keyMoments) || m.keyMoments.length < 2)
    return { ok: false, error: "need ≥ 2 keyMoments" };
  for (const km of m.keyMoments) {
    if (!n(km?.day)) return { ok: false, error: "keyMoment missing day" };
    if (!km?.label || !km?.narration)
      return { ok: false, error: "keyMoment missing label/narration" };
  }
  return { ok: true };
}

// Convert validated metadata into a scenario that matches the shape the
// replay UI already expects (same as entries in data/crashes.js).
function buildScenario(m) {
  const panicDay = Math.max(1, Math.min(Math.floor(m.panicDay ?? 3), m.totalDays - 1));
  const frames = [];
  const narrations = {};

  for (let i = 0; i < m.totalDays; i++) {
    const niftyLevel = interpIndex(i, m);
    const heldPortfolio = Math.round(100000 * (niftyLevel / m.startIndex));
    const panicPortfolio = i < panicDay
      ? heldPortfolio
      : Math.round(100000 * (interpIndex(panicDay, m) / m.startIndex));
    const f = { day: i, nifty: Math.round(niftyLevel), held: heldPortfolio, panic: panicPortfolio };
    frames.push(f);
  }

  // Sort key moments by day + dedupe on day (prefer first), then attach.
  // Clamp any day that crept outside the window — reshape() should have
  // grown totalDays to fit, but defend just in case the LLM reshuffled.
  const seenDays = new Set();
  const cleanMoments = m.keyMoments
    .map(km => ({
      ...km,
      day: Math.max(0, Math.min(m.totalDays - 1, Math.floor(km.day))),
    }))
    .filter(km => {
      if (seenDays.has(km.day)) return false;
      seenDays.add(km.day);
      return true;
    })
    .sort((a, b) => a.day - b.day);

  for (const km of cleanMoments) {
    const key = "n_custom_" + km.day;
    narrations[key] = km.narration;
    if (frames[km.day]) frames[km.day].n = key;
  }

  const startHeld = frames[0].held;
  const endHeld = frames[frames.length - 1].held;
  const endPanic = frames[frames.length - 1].panic;
  const finalDelta = ((endHeld - endPanic) / endPanic) * 100;

  const id = "CUSTOM_" + slugify(m.title) + "_" + Date.now().toString(36);
  return {
    id,
    title: String(m.title).slice(0, 80),
    subtitle: `${m.startLabel} – ${m.endLabel}`,
    description: String(m.description).slice(0, 2000),
    startLabel: m.startLabel,
    endLabel: m.endLabel,
    finalDelta: Math.round(finalDelta * 10) / 10,
    heldEnd: endHeld,
    panicEnd: endPanic,
    indexDrop: Math.round(m.indexDrop * 10) / 10,
    recoveryDays: Math.max(0, Math.floor(m.recoveryDays ?? 0)),
    frames,
    narrations,
    isCustom: true,
  };
}

// Piecewise curve from day 0 → trough → end. Decline is slightly convex
// (panic accelerates), recovery is concave (slows down near the top).
// No randomness — output is deterministic for a given metadata set, which
// matters for reproducibility in the replay.
function interpIndex(day, m) {
  if (day <= 0) return m.startIndex;
  if (day >= m.totalDays - 1) return m.endIndex;
  if (day <= m.troughDay) {
    const t = day / m.troughDay;
    const frac = Math.pow(t, 1.4);
    return m.startIndex + (m.troughIndex - m.startIndex) * frac;
  } else {
    const t = (day - m.troughDay) / (m.totalDays - 1 - m.troughDay);
    const frac = Math.sqrt(t);
    return m.troughIndex + (m.endIndex - m.troughIndex) * frac;
  }
}

function slugify(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 24).replace(/^_+|_+$/g, "") || "X";
}
