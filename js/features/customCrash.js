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

// -----------------------------------------------------------------------------
// PROFILING — landed first per PERF_AUDIT §1. Performance API marks cost ~µs
// each so they are always on. The console.table report is gated on
//   ?perf  query param  OR  localStorage["ss.perf"] = "1"
// so normal users never see log spam. When the gate is open you get a
// single grouped table per generation:
//   SEGMENT                 | ms
//   cc:local-cache          |   2
//   cc:cache-get            | 180
//   cc:phaseA               | 950
//   ...
// Server-Timing headers from /api/chat and /api/ai are parsed and folded
// into the same buffer so the table includes both client- and server-side
// numbers. Backed by the §1 timing-hook list — keep both in sync.
// -----------------------------------------------------------------------------
const _perfBuf = [];
function _perfMark(name) {
  try { performance.mark(name); } catch {}
}
function _perfMeasure(name, startMark, endMark) {
  try {
    performance.measure(name, startMark, endMark);
    const m = performance.getEntriesByName(name, "measure").pop();
    if (m) _perfBuf.push({ seg: name, ms: Math.round(m.duration) });
  } catch {}
}
function _perfServerTiming(res, label) {
  try {
    const st = res?.headers?.get?.("server-timing");
    if (!st) return;
    // Parse "ttft;dur=420, llm;dur=3200;desc=\"gemini_json\""
    for (const part of st.split(",").map(s => s.trim())) {
      const toks = part.split(";").map(t => t.trim());
      const name = toks[0];
      let dur = null, desc = null;
      for (const t of toks.slice(1)) {
        if (t.startsWith("dur=")) dur = Number(t.slice(4));
        else if (t.startsWith("desc=")) desc = t.slice(5).replace(/^"|"$/g, "");
      }
      if (name && Number.isFinite(dur)) {
        _perfBuf.push({ seg: `${label}:${name}`, ms: Math.round(dur), upstream: desc || "" });
      }
    }
  } catch {}
}
function _perfReport() {
  let enabled = false;
  try {
    enabled = /[?&]perf\b/.test(location.search) || localStorage.getItem("ss.perf") === "1";
  } catch {}
  if (!enabled) { _perfBuf.length = 0; return; }
  try {
    console.groupCollapsed("[crash-replay perf]");
    console.table(_perfBuf);
    const total = performance.getEntriesByName("cc:total", "measure").pop();
    if (total) console.log(`TOTAL ${Math.round(total.duration)} ms (cc:start → cc:first-paint)`);
    console.groupEnd();
  } catch {}
  _perfBuf.length = 0;
}
// Expose so crashReplay.js can call it after first paint, and so devtools
// users can poke at the buffer manually.
if (typeof window !== "undefined") {
  window.__ccPerfReport = _perfReport;
  window.__ccPerfBuf = _perfBuf;
}
// =============================================================================

// Phase 1: pick the event's date range + target index. Tiny prompt, tiny
// response, ~500ms. The server then fetches REAL historical daily closes
// from Yahoo for that range in phase 2, which get fed back into phase 3
// so the final replay is grounded in real data — no hallucinated Nifty
// levels ever again.
const PHASE1_PROMPT = `You are Saathi's historical-event-date picker for Indian markets. Given a free-form description of any Indian market event — even COLLOQUIAL, MIS-SPELT, or HINDI-INFLECTED references — identify the real event and return ONLY JSON:
{
  "startIso": "<YYYY-MM-DD — first trading day of the event>",
  "endIso":   "<YYYY-MM-DD — last day of the recovery/stabilisation window to plot, max 140 trading days after startIso>",
  "symbol":   "^NSEI" | "^BSESN" | "<any NSE ticker>.NS",
  "hint":     "<one-sentence identification of which actual event this refers to, INCLUDING the colloquial-to-formal mapping if relevant>",
  "offTopic": <true only if the query is adult content, vulgar, or has absolutely zero connection to Indian markets/business/policy>
}

Colloquial → formal examples (use these, and handle similar):
- "the waterball / golgappa / pani puri thingy" / "that fuchka vendor story" → Tamil Nadu pani puri vendor GST notice, June 2023 (set symbol "^NSEI", startIso 2023-06-01, endIso 2023-07-31)
- "that telecom guy" / "Jio launch" → Reliance Jio launch, Sep 2016
- "demon" / "demonetization" / "note band" → Demonetisation, 8 Nov 2016
- "the soap guy scam" / "Nirav Modi" → Nirav Modi / PNB fraud, 14 Feb 2018
- "lockdown crash" / "covid" / "corona" → COVID March 2020
- "the short seller thing" / "hindenburg" → Adani Hindenburg report, 24 Jan 2023
- "IL&FS" / "the NBFC thing" → IL&FS collapse, Sep 2018
- "Satyam" / "computer scam" → Satyam fraud, 7 Jan 2009
- "yes bank" / "yes guy" / "yes" → YES Bank moratorium, 5 Mar 2020
- "Paytm IPO flop" → Paytm listing, 18 Nov 2021 (symbol PAYTM.NS)
- "Adani board thing" / "Adani Enterprises FPO" → Adani FPO cancellation, 1 Feb 2023 (symbol ADANIENT.NS)

Rules:
- startIso MUST be before endIso. Window 10-140 trading days.
- If the event affected a specific stock more than the index, set symbol to that ticker (e.g. "PAYTM.NS", "ADANIENT.NS", "YESBANK.NS", "RELIANCE.NS"). Otherwise default to ^NSEI.
- For rallies/booms/IPO-pops, still pick a range — we'll judge downstream whether the real move was down.
- offTopic:true ONLY for adult content (porn/sex/nudity), vulgarity with no market angle, personal life, sports scores, recipes, weather. When offTopic:true, use a throwaway recent date range (we'll refuse downstream).
- Return ONLY the JSON. No prose, no code fences.`;

// Fast client-side filter for clearly inappropriate queries. We check
// BEFORE any Gemini call so a user typing "pornhub" doesn't burn credits
// OR land a replay with suggestive content. Keeping the list short and
// high-signal — adult content, common slurs, explicit acts. The LLM's
// offTopic:true flag in Phase A catches the long tail.
const HARD_BLOCK_PATTERNS = [
  /\b(porn|pornhub|xxx|nsfw|nude|naked|erotic|onlyfans|escort|hentai|cam\s*girl)\b/i,
  /\b(sex(ual|y)?|fuck(ing|ed|er)?|cock|dick|pussy|boob|tits|ass\s*hole|bitch|whore|slut)\b/i,
  /\b(rape|molest|paedo|pedo|child\s*porn)\b/i,
];
function isHardBlocked(text) {
  const t = String(text || "").toLowerCase();
  return HARD_BLOCK_PATTERNS.some(rx => rx.test(t));
}

const SYSTEM_PROMPT = `You are a financial-history reconstructor for Indian markets. You are given REAL daily closing-price data from Yahoo Finance for the event's date range. Use the real numbers — do NOT hallucinate alternatives.

YOUR DEFAULT IS TO BUILD, NOT REFUSE.
- Identify the event the user is describing. The provided REAL market data is for the date range you picked in phase 1.
- Use the REAL startIndex (first close), troughIndex (lowest close), endIndex (last close), and troughDay (index of lowest close). These are facts, not estimates.
- Write narration + description that truthfully explain what happened on each key date using the real numbers.
- If the real data shows the index WENT UP (not a crash), return: { "error": "not_a_crash", "message": "<one sentence noting the real move was positive and suggesting a related DOWN event>" }
- ONLY refuse with "not_a_crash" if the user's query is clearly non-market (sports, recipes).

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
- startIndex, troughIndex, endIndex, troughDay MUST come from the REAL data provided — no fabrication.
- indexDrop = ((troughIndex - startIndex) / startIndex) * 100, rounded to 1 decimal. Will be negative for real crashes.
- totalDays = number of trading days in the provided data (== data.length).
- Include 4 to 7 keyMoments whose "day" values map to actual indices in the provided data array (not fake dates).
- keyMoment narrations reference the REAL price on that day where useful.
- IMPORTANT: every price you cite is a CLOSING price (these come from daily close-price arrays). Phrase as "stock closed at â‚¹X", "closes at â‚¹X", "the close was â‚¹X". NEVER write "opens at", "opening price", "opens to" â€” you do not have intraday open prices, and writing as if you do is factually wrong. For after-hours news events (RBI moratorium, regulatory bans, results announcements) the day-0 narration must say "closes at â‚¹X" because the news broke AFTER the market close â€” the â‚¹X figure is the last clean price before the news, not an opening price.
- REFUSE ONLY if the real data clearly shows an UP move or the query is non-market (sports/recipes).`;

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
// at whichever scenario id was generated for this query first. Mirrors the
// aggressive tokenise+sort used by queryHash so the local-cache lookup
// matches the same rephrasings the server-cache matches.
function queryKey(desc) {
  const tokens = String(desc || "")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return Array.from(new Set(tokens)).sort().join("_").slice(0, 120);
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
//
// Normalisation is AGGRESSIVE on purpose: users rephrase ("Adani Hindenburg
// 2023" vs "Hindenburg 2023 Adani" vs "AdaniHindenburg2023" vs "adani-
// hindenburg 2023!") and without collapsing these we'd cache-miss on every
// rephrasing and burn LLM credits regenerating the same scenario.
//
// Strategy:
//   1. Split letter/digit runs ("hindenburg2023" → "hindenburg 2023")
//   2. Lowercase
//   3. Replace every non-alphanumeric run with a single space
//   4. Split into word-tokens, dedupe, sort alphabetically
//   5. Rejoin — word-order no longer matters, punctuation no longer matters
//
// Side effect: "Adani 2023" and "2023 Adani" hash the same (fine — same
// event). "Adani Enterprises IPO" vs "IPO Adani Enterprises" same. "Adani
// Hindenburg" vs "Hindenburg Adani" same. What they hash DIFFERENTLY from:
// queries that contain genuinely distinct words ("Adani IPO 2023" vs
// "Adani Hindenburg 2023") — which is correct, those are different events.
async function queryHash(desc) {
  const tokens = String(desc || "")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const canonical = Array.from(new Set(tokens)).sort().join(" ").slice(0, 400);
  const bytes = new TextEncoder().encode(canonical);
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
    _perfServerTiming(res, "cache");
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
  // PERF — start of cold-start clock. cc:first-paint is fired by
  // crashReplay.js after the chart renders; cc:total measures the wall
  // clock between them. See PERF_AUDIT §1.
  _perfMark("cc:start");

  // 0. Hard content filter — reject adult / vulgar / slur queries BEFORE
  //    any LLM call. These would either burn Gemini credits on junk or
  //    surface an inappropriate-looking replay. Rejection is friendly —
  //    we don't shame the user, just redirect them.
  if (isHardBlocked(description)) {
    const err = new Error("That isn't something I can turn into a market replay. Try a real event like 'Harshad Mehta 1992' or 'Adani Hindenburg 2023'.");
    err.kind = "not_a_crash";
    throw err;
  }

  // Stable hash of the prompt — serves as both the cross-user cache key and
  // the suffix of the scenario id, so the same prompt always yields the same
  // URL regardless of browser/device/user.
  const hash = await queryHash(description);

  // 1. Local dedup (same-browser instant reuse, survives cache-miss too).
  _perfMark("cc:local-start");
  const cachedId = existingScenarioForQuery(description);
  _perfMark("cc:local-end");
  _perfMeasure("cc:local-cache", "cc:local-start", "cc:local-end");
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
  _perfMark("cc:cache-start");
  const cached = await cacheReplayGet(hash);
  _perfMark("cc:cache-end");
  _perfMeasure("cc:cache-get", "cc:cache-start", "cc:cache-end");
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

  // 3. Cache miss → THREE-PHASE grounded generation:
  //    a) LLM picks the event's startIso/endIso/symbol
  //    b) Server fetches REAL daily closes from Yahoo for that range
  //    c) LLM generates the replay JSON using the real numbers (no hallucination)
  let lastErr = null;

  // Phase A: pick dates + symbol
  _perfMark("cc:phaseA-start");
  let bracket;
  try {
    bracket = await callLlmForBracket(description);
  } catch (e) {
    _perfMark("cc:phaseA-end");
    _perfMeasure("cc:phaseA", "cc:phaseA-start", "cc:phaseA-end");
    throw new Error("Couldn't figure out the event's dates. Try a more specific phrasing, like 'Adani Hindenburg Jan 2023' or 'COVID March 2020'.");
  }
  _perfMark("cc:phaseA-end");
  _perfMeasure("cc:phaseA", "cc:phaseA-start", "cc:phaseA-end");
  // LLM's off-topic flag — catches adult/vulgar/zero-market queries that the
  // regex blocklist missed. Reject cleanly.
  if (bracket?.offTopic === true) {
    const err = new Error(`That doesn't fit a market replay. Try something like "${pickRandomExample()}".`);
    err.kind = "not_a_crash";
    throw err;
  }
  if (!bracket?.startIso || !bracket?.endIso) {
    throw new Error("Couldn't figure out the event's dates. Try a more specific phrasing.");
  }

  // Phase B: fetch real historical data in PARALLEL for the main symbol +
  // companion indices, so Phase C sees broader sector context (Bank Nifty
  // for bank events, Nifty IT for tech events, etc.). The primary symbol
  // is the source of truth for the chart; companions are context-only
  // and don't block rendering if they fail.
  const primary = bracket.symbol || "^NSEI";
  const companions = pickCompanionSymbols(primary, description);
  _perfMark("cc:phaseB-start");
  const fetches = [
    fetchHistory(primary, bracket.startIso, bracket.endIso).catch(() => null),
    ...companions.map(sym => fetchHistory(sym, bracket.startIso, bracket.endIso).catch(() => null)),
  ];
  const results = await Promise.all(fetches);
  _perfMark("cc:phaseB-end");
  _perfMeasure("cc:phaseB", "cc:phaseB-start", "cc:phaseB-end");
  let history = results[0];
  const companionHistory = results.slice(1).filter(h => h && h.points && h.points.length >= 5);
  // Fallback: if the LLM picked a specific ticker and Yahoo returned too little
  // data, retry with ^NSEI before giving up. This catches delisted-stock
  // events where the stock no longer exists on Yahoo (Satyam 2009 →
  // SATYAMCOMP.NS was absorbed by Tech Mahindra and is no longer queryable;
  // the Nifty 50 move on Raju's confession day IS captured in ^NSEI) and
  // tickers with non-standard Yahoo suffixes that we can't guess.
  if ((!history?.points?.length || history.points.length < 5) && primary !== "^NSEI") {
    const fallback = await fetchHistory("^NSEI", bracket.startIso, bracket.endIso).catch(() => null);
    if (fallback?.points?.length >= 5) {
      history = fallback;
      bracket.symbol = "^NSEI"; // propagate so the narrative references the right index
    }
  }
  if (!history?.points?.length || history.points.length < 5) {
    throw new Error("Not enough historical data for that range. Try a different event or check your date phrasing.");
  }

  // Real data gives us the hard truth about whether this was a crash or rally.
  const closes = history.points.map(p => p.c);
  const startIdx = closes[0];
  const troughIdx = Math.min(...closes);
  const endIdx = closes[closes.length - 1];
  const troughDayIdx = closes.indexOf(troughIdx);
  const realDropPct = ((troughIdx - startIdx) / startIdx) * 100;

  // If the real index went UP the whole time, this isn't a crash event.
  if (realDropPct >= -2) {
    const err = new Error(`Real market data for ${bracket.startIso} to ${bracket.endIso} doesn't show a notable drop (${realDropPct.toFixed(1)}%). Pick a real crash event like 'COVID March 2020' or 'Harshad Mehta 1992'.`);
    err.kind = "not_a_crash";
    throw err;
  }

  // Phase C: generate narrative with real data in context
  for (const { profile, temperature } of ATTEMPTS) {
    try {
      _perfMark("cc:phaseC-start");
      const meta = await callLlmWithHistory(description, bracket, history, companionHistory, temperature, profile);
      _perfMark("cc:phaseC-end");
      _perfMeasure("cc:phaseC", "cc:phaseC-start", "cc:phaseC-end");
      if (meta && meta.error === "not_a_crash") {
        const msg = typeof meta.message === "string" && meta.message.trim()
          ? meta.message.trim()
          : `That event wasn't a crash (real ${bracket.symbol} move was ${realDropPct.toFixed(1)}%). Try 'Harshad Mehta 1992' or 'Adani Hindenburg 2023'.`;
        const err = new Error(msg);
        err.kind = "not_a_crash";
        throw err;
      }
      // Overwrite any hallucinated numbers with the REAL ones. The LLM's
      // numbers are a sanity cross-check; the real-data numbers are truth.
      _perfMark("cc:parse-start");
      if (meta && typeof meta === "object") {
        meta.startIndex = Math.round(startIdx * 100) / 100;
        meta.troughIndex = Math.round(troughIdx * 100) / 100;
        meta.endIndex = Math.round(endIdx * 100) / 100;
        meta.troughDay = troughDayIdx;
        meta.totalDays = history.points.length;
        meta.indexDrop = Math.round(realDropPct * 10) / 10;
        meta.startLabel = meta.startLabel || formatIsoToLabel(bracket.startIso);
        meta.endLabel = meta.endLabel || formatIsoToLabel(bracket.endIso);
      }
      reshape(meta);
      const valid = validate(meta);
      _perfMark("cc:parse-end");
      _perfMeasure("cc:parse-validate", "cc:parse-start", "cc:parse-end");
      if (!valid.ok) { lastErr = valid.error; continue; }
      // Attach real daily closes so buildScenario can use them for the
      // day-by-day curve instead of interpolating.
      meta._realCloses = closes;
      meta._startIso = bracket.startIso;
      _perfMark("cc:build-start");
      const scenario = buildScenario(meta, hash);
      _perfMark("cc:build-end");
      _perfMeasure("cc:buildScenario", "cc:build-start", "cc:build-end");
      rememberQuery(queryKey(description), scenario.id);
      cacheReplayPut(hash, description, scenario);
      return scenario;
    } catch (e) {
      if (e?.kind === "not_a_crash") throw e;
      lastErr = e?.message || String(e);
    }
  }
  throw new Error(lastErr || "The coach couldn't build that one. Try rephrasing.");
}

function formatIsoToLabel(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch { return iso; }
}

const EXAMPLE_EVENTS = [
  "Harshad Mehta 1992",
  "Satyam scandal 2009",
  "Global Financial Crisis 2008",
  "COVID March 2020",
  "Demonetisation 2016",
  "YES Bank moratorium 2020",
  "Adani Hindenburg 2023",
  "Paytm IPO 2021",
  "Nirav Modi PNB fraud",
  "IL&FS collapse 2018",
];
function pickRandomExample() {
  return EXAMPLE_EVENTS[Math.floor(Math.random() * EXAMPLE_EVENTS.length)];
}

// Phase A: ask Gemini for the event's date range + target symbol.
async function callLlmForBracket(description) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: PHASE1_PROMPT },
        { role: "user", content: String(description).trim().slice(0, 400) },
      ],
      temperature: 0.1,
      max_tokens: 200,
      response_format: { type: "json_object" },
      profile: "json",
    }),
  });
  _perfServerTiming(res, "phaseA");
  if (!res.ok) throw new Error(`phase1_http_${res.status}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  const parsed = parseJsonLoose(text);
  if (!parsed) throw new Error("phase1_non_json");
  // Normalise loose LLM outputs.
  // Dates: the prompt asks for YYYY-MM-DD but Gemini sometimes emits full
  // ISO-8601 with T00:00:00Z — just slice the date portion.
  if (typeof parsed.startIso === "string") parsed.startIso = parsed.startIso.slice(0, 10);
  if (typeof parsed.endIso === "string") parsed.endIso = parsed.endIso.slice(0, 10);
  // Symbol: must match Yahoo's ticker shape (letters/digits/caret/dot/dash).
  // "GST" or similar made-up strings → fall back to the index.
  const validSymbolRe = /^[A-Za-z0-9.\-\^]{1,24}$/;
  const knownSymbols = new Set(["^NSEI", "^BSESN", "^NSEBANK", "^CNXIT", "^CNXFMCG", "^CNXAUTO", "^CNXPHARMA"]);
  if (!parsed.symbol || typeof parsed.symbol !== "string" ||
      !validSymbolRe.test(parsed.symbol) ||
      // Single-word non-ticker like "GST", "NIFTY", "INDIA"
      (!knownSymbols.has(parsed.symbol) && !parsed.symbol.includes(".") && !parsed.symbol.startsWith("^"))) {
    parsed.symbol = "^NSEI";
  }
  // Date sanity
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.startIso || "")) throw new Error("phase1_bad_start");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.endIso || "")) throw new Error("phase1_bad_end");
  // Widen too-narrow ranges — a 30-day window is often too tight for a good
  // replay. Extend endIso by 60 days if < 30 trading days apart to give the
  // market time to show a full drawdown + partial recovery.
  const startMs = new Date(parsed.startIso).getTime();
  const endMs = new Date(parsed.endIso).getTime();
  if (!isNaN(startMs) && !isNaN(endMs) && endMs - startMs < 30 * 86400_000) {
    const wider = new Date(startMs + 90 * 86400_000);
    parsed.endIso = wider.toISOString().slice(0, 10);
  }
  return parsed;
}

// Phase B: fetch Yahoo historical data via our server-side proxy.
async function fetchHistory(symbol, fromIso, toIso) {
  const qs = `symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
  const res = await fetch(`/api/ai?op=history&${qs}`);
  _perfServerTiming(res, "phaseB");
  if (!res.ok) throw new Error(`history_http_${res.status}`);
  return await res.json();
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

// Pick companion symbols for richer sector context in Phase C. Doesn't
// change the chart — just feeds the LLM extra datapoints to draw on.
// Keep it to 2-3 max to keep prompt tokens reasonable.
function pickCompanionSymbols(primary, description) {
  const d = String(description || "").toLowerCase();
  const already = primary.toUpperCase();
  const want = new Set();
  // Always add Bank Nifty for the broadest "banks vs rest" signal.
  if (already !== "^NSEBANK") want.add("^NSEBANK");
  // IT events → Nifty IT
  if (/\b(it|infosys|tcs|wipro|hcl|tech|software)\b/.test(d)) want.add("^CNXIT");
  // FMCG / consumer events → Nifty FMCG
  if (/\b(fmcg|consumer|hindustan|itc|nestle|dabur|britannia|pani\s*puri|golgappa|fuchka)\b/.test(d)) want.add("^CNXFMCG");
  // Auto events → Nifty Auto
  if (/\b(auto|maruti|tata\s*motors|bajaj|hero|eicher|mahindra)\b/.test(d)) want.add("^CNXAUTO");
  // Pharma events → Nifty Pharma
  if (/\b(pharma|sun\s*pharma|cipla|dr\s*reddy|lupin)\b/.test(d)) want.add("^CNXPHARMA");
  // If primary is a specific stock, also pull the sector index above.
  // If primary is ^NSEI already, add ^BSESN for cross-check.
  if (primary === "^NSEI" && !want.has("^BSESN")) want.add("^BSESN");
  // Cap at 3 companions to keep Promise.all fast + prompt lean.
  return Array.from(want).slice(0, 3);
}

async function callLlmWithHistory(description, bracket, history, companionHistory, temperature, profile) {
  // Compose a compact, LLM-readable table of the real daily closes.
  const closes = history.points.map(p => p.c);
  const dates = history.points.map(p => p.d);
  const startIdx = closes[0];
  const troughIdx = Math.min(...closes);
  const endIdx = closes[closes.length - 1];
  const troughDayIdx = closes.indexOf(troughIdx);
  const realDropPct = ((troughIdx - startIdx) / startIdx) * 100;
  // Pack ~30 sampled points to keep context small (full array can be 140+).
  const step = Math.max(1, Math.floor(closes.length / 30));
  const sample = [];
  for (let i = 0; i < closes.length; i += step) {
    sample.push(`${i}=${dates[i]}@${Math.round(closes[i] * 100) / 100}`);
  }
  if (sample[sample.length - 1]?.startsWith(`${closes.length - 1}=`) === false) {
    sample.push(`${closes.length - 1}=${dates[closes.length - 1]}@${Math.round(endIdx * 100) / 100}`);
  }
  const factsBlock = [
    `SYMBOL: ${history.symbol}`,
    `DATE RANGE: ${dates[0]} to ${dates[dates.length - 1]}`,
    `TOTAL TRADING DAYS: ${closes.length}`,
    `START CLOSE: ${Math.round(startIdx * 100) / 100} (day 0)`,
    `TROUGH CLOSE: ${Math.round(troughIdx * 100) / 100} (day ${troughDayIdx}, ${dates[troughDayIdx]})`,
    `END CLOSE: ${Math.round(endIdx * 100) / 100} (day ${closes.length - 1})`,
    `REAL DROP: ${realDropPct.toFixed(2)}% from start to trough`,
    `SAMPLED CLOSES (day=date@price): ${sample.join(", ")}`,
    `LLM-IDENTIFIED EVENT: ${bracket.hint || "unknown"}`,
  ].join("\n");
  // Tack on companion-symbol context so the LLM can write narration that
  // references sector relativity (e.g. "banks fell 12% while IT held").
  let companionBlock = "";
  if (companionHistory && companionHistory.length) {
    companionBlock = "\n\nCOMPANION SYMBOLS (for sector context only, NOT the chart):\n" + companionHistory.map(h => {
      const cc = h.points.map(p => p.c);
      const s = cc[0];
      const t = Math.min(...cc);
      const e = cc[cc.length - 1];
      const dp = ((t - s) / s) * 100;
      return `  ${h.symbol}: ${s.toFixed(0)} → trough ${t.toFixed(0)} → ${e.toFixed(0)} (drop ${dp.toFixed(2)}%)`;
    }).join("\n");
  }
  const userMsg = `Event description from user: "${String(description).trim().slice(0, 400)}"\n\nREAL MARKET DATA (use these exact numbers, not your memory):\n${factsBlock}${companionBlock}`;
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      temperature,
      max_tokens: 2000,
      response_format: { type: "json_object" },
      profile,
    }),
  });
  _perfServerTiming(res, "phaseC");
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
  // If Phase B produced a real close-price array, use it verbatim. Every
  // frame's Nifty value is a real Yahoo close, not an interpolated curve.
  // Falls back to interpIndex only if real data isn't available (never
  // happens in the new flow but kept for defensive backcompat).
  const realCloses = Array.isArray(m._realCloses) ? m._realCloses : null;

  for (let i = 0; i < m.totalDays; i++) {
    const niftyLevel = realCloses && realCloses[i] != null
      ? realCloses[i]
      : interpIndex(i, m);
    const panicNiftyLevel = realCloses && realCloses[panicDay] != null
      ? realCloses[panicDay]
      : interpIndex(panicDay, m);
    const heldPortfolio = Math.round(100000 * (niftyLevel / m.startIndex));
    const panicPortfolio = i < panicDay
      ? heldPortfolio
      : Math.round(100000 * (panicNiftyLevel / m.startIndex));
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
