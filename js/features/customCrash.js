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

const SYSTEM_PROMPT = `You are a financial-history reconstructor for Indian markets. Given ANY description — specific, vague, mis-spelt, niche, obscure, or approximate — your job is to figure out what Indian event the user probably means and build a crash-style day-by-day replay for it.

YOUR DEFAULT IS TO BUILD, NOT REFUSE.
- If the query is a real crash/correction/scandal/panic: reconstruct it from memory, including Nifty/Sensex levels and dates. Approximations are fine — the user knows the numbers are estimates.
- If the query is a real event but not obviously a crash (e.g. "Pani Puri vendor GST notice", "Adani board reshuffle", "SEBI circular on f&o"): think about how that event REVERBERATED through listed stocks — did FMCG dip, did a related sector sell off, did mid-caps wobble on sentiment? Build the replay around the PROXY market reaction, describing it honestly.
- If the query is mis-spelt or vague ("the one waterballl golgappa thingy"): figure out what the user probably means (the viral 2023 pani puri vendor GST-notice story) and build a replay of the consumer-stock / FMCG / mid-cap sentiment wobble around that news cycle. Even if the actual index move was small, construct a believable scaled replay.
- If the query is clearly an UP event (bull run, IPO pop, positive earnings blowout) and the user explicitly called it a rally/boom/surge: return { "error": "not_a_crash", "message": "<one sentence suggesting a related DOWN event they could try instead>" }. Otherwise, try to build it.
- ONLY refuse with "not_a_crash" if the query is so totally unrelated to Indian markets that no construction is possible (e.g. "my dog's birthday", "recipe for biryani"). In that case, suggest they try something like "Harshad Mehta 1992" or "Adani Hindenburg 2023".

If you're building a scenario, return a JSON object with this EXACT shape:

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
- indexDrop MUST be negative, at least -3 (i.e. a ≥3% drop — if the real event was smaller, scale it proportionally so the replay is still instructive; make this clear in the description).
- Include 4 to 7 keyMoments covering: start context, first panic, trough, any mid-course inflection, recovery or finish.
- If you're uncertain about exact numbers, APPROXIMATE confidently. The description can note "approximate reconstruction" but the numbers must still be filled in.
- REFUSE ONLY for clearly non-market topics (sports, recipes, weather, personal life). Mis-spelt queries, vague references, and niche business/regulatory events are ALL in scope — build a plausible replay for them.`;

const MAX_DAYS = 140;

// Each attempt tuple is [profile, temperature]. We lead with the json
// profile (Gemini 2.5 Flash — non-thinking, reliable structured output)
// because Gemini 3.x preview models burn so many tokens on internal
// reasoning that the JSON gets truncated mid-object. If the json attempts
// fail validation (rare — only on wildly ambiguous queries), we escalate
// to reasoning (Pro) with full thinking budget for the hard cases.
const ATTEMPTS = [
  { profile: "json",      temperature: 0.2  },
  { profile: "json",      temperature: 0.55 },
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

// Stable SHA-256 of a normalised description. Used as the cross-user cache
// key AND as the deterministic suffix for the scenario id so the generated
// URL is stable for a given prompt — shareable, and identical across users.
async function queryHash(desc) {
  const normalised = String(desc || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 400);
  const bytes = new TextEncoder().encode(normalised);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Cross-user cache via /api/ai?op=cache-get|cache-put (Supabase-backed).
// Popular prompts get generated once, ever — the first user pays the LLM
// cost, everyone after that gets an instant hit on the same scenario, same
// stable URL. Fire-and-forget write — the UI never blocks on cache I/O.
async function cacheReplayGet(hash) {
  try {
    const res = await fetch(`/api/ai?op=cache-get&bucket=crash_replay&key=${encodeURIComponent(hash)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.hit ? data.payload : null;
  } catch { return null; }
}
function cacheReplayPut(hash, description, payload) {
  try {
    fetch("/api/ai?op=cache-put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bucket: "crash_replay",
        key: hash,
        display: String(description || "").slice(0, 200),
        payload,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

export async function generateCustomCrash(description) {
  // Stable hash of the prompt — serves as both the cross-user cache key and
  // the suffix of the scenario id, so the same prompt always yields the same
  // URL regardless of browser/device/user.
  const hash = await queryHash(description);

  // 1. Local dedup (same-browser instant reuse, survives cache-miss too).
  const cachedId = existingScenarioForQuery(description);
  if (cachedId) {
    try {
      const all = JSON.parse(localStorage.getItem("ss.customCrashes.v1") || "{}");
      if (all[cachedId]) return all[cachedId];
    } catch {}
  }

  // 2. Supabase cross-user cache. First user generates + pays; everyone else
  //    pulls for free. We DO NOT cache refusals — a refusal is often a
  //    model-mood mistake (overzealous not_a_crash), and re-querying should
  //    be free to produce a real replay. Only successful scenarios are cached.
  const cached = await cacheReplayGet(hash);
  if (cached && cached.id && !cached.error) {
    // Hydrate localStorage so subsequent loads hit the local path first.
    try {
      const all = JSON.parse(localStorage.getItem("ss.customCrashes.v1") || "{}");
      all[cached.id] = cached;
      localStorage.setItem("ss.customCrashes.v1", JSON.stringify(all));
    } catch {}
    rememberQuery(queryKey(description), cached.id);
    return cached;
  }

  // 3. Cache miss → call the LLM (and write back on success).
  let lastErr = null;
  for (const { profile, temperature } of ATTEMPTS) {
    try {
      const meta = await callLlmForMeta(description, temperature, profile);
      // LLM may refuse non-crash queries (rallies, tiny moves) — surface cleanly.
      if (meta && meta.error === "not_a_crash") {
        const msg = typeof meta.message === "string" && meta.message.trim()
          ? meta.message.trim()
          : "That event was a rally, not a crash. The time-travel replay is built for market drops — try something like 'Diwali 2008 correction' instead.";
        // Do NOT cache — refusals are often wrong on niche or vague queries.
        // Next retry (possibly with Gemini active, or just a different mood)
        // should be free to produce a real replay.
        const err = new Error(msg);
        err.kind = "not_a_crash";
        throw err;
      }
      reshape(meta);
      const valid = validate(meta);
      if (!valid.ok) { lastErr = valid.error; continue; }
      const scenario = buildScenario(meta, hash);
      rememberQuery(queryKey(description), scenario.id);
      cacheReplayPut(hash, description, scenario);
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

// Robust JSON parser — handles Markdown code fences and leading/trailing
// prose that Gemini 3.x preview models sometimes emit despite response_format.
// Mirrors the server-side parseJsonLoose in api/ai.js.
function parseJsonLoose(text) {
  if (typeof text !== "string") return null;
  try { return JSON.parse(text); }
  catch {}
  // Try a ```json ... ``` fence first (most common model misbehaviour).
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }
  // Last resort: biggest `{ ... }` substring we can find.
  const first = text.indexOf("{");
  const last  = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  return null;
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
      // Comfortable budget: fits the full crash-replay JSON schema AND any
      // thinking tokens the reasoning-escalation path consumes on 3.x Pro.
      max_tokens: 2000,
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
  const meta = parseJsonLoose(text);
  if (!meta) throw new Error("The coach's answer didn't parse cleanly. Try again or rephrase.");
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
function buildScenario(m, hash) {
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

  // Deterministic id — same prompt → same hash → same id → same shareable URL.
  // Falls back to a timestamp only if hash wasn't supplied (shouldn't happen in
  // the real flow; defensive default to preserve old callers).
  const idSuffix = hash ? hash.slice(0, 12) : Date.now().toString(36);
  const id = "CUSTOM_" + slugify(m.title) + "_" + idSuffix;
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
