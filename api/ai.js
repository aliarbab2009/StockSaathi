// =============================================================================
// /api/ai  —  Consolidated router for every AI feature in StockSaathi.
//
// Why one file: Vercel Hobby tier caps at 12 functions; shipping each AI
// surface as its own endpoint blew past that. This router keeps every
// feature inside one Edge function, sharing the LLM call + cache helpers
// in-process. Also eliminates the internal-fetch 401 we were hitting
// when child endpoints called /api/chat through VERCEL_URL (deployment-
// protection wall).
//
// Dispatch: GET/POST /api/ai?op=<name>
//   op=cache-get          GET  { bucket, key }            -> { payload|null, hit }
//   op=cache-put          POST { bucket, key, display, payload } -> { ok }
//   op=explain            GET  { term }                   -> { explanation, source }
//   op=news-tldr          POST { headline, source, symbols } -> { sentiment, tldr, source }
//   op=portfolio-digest   POST { totalRupees, deltaPct, cashRupees, holdings } -> { narrative, mood }
//   op=stock-why          POST { symbol, name, sector, pricePaise, changePct, newsItems } -> { explanation }
//   op=trade-nudge        POST { action, symbol, name, sector, qty, priceRupees, portfolio } -> { nudge, severity }
//   op=market-mood        POST { sectors, asOf }          -> { narrative, temperature }
//   op=market-search      POST { query, candidates }      -> { matches, rationale }
//   op=report-card        POST { totalTrades, winRate, biggestWin, biggestLoss, avgHoldDays, biasFlags, portfolioReturnPct, topSectors, startedAt } -> { narrative, strengths, watchouts }
//   op=crash-suggestions  GET                             -> { suggestions }
//   op=command            POST { query, context }         -> { action, response, target?, query?, symbol?, side?, qty? }
// =============================================================================

export const config = { runtime: "edge" };

const MAX_BODY = 128 * 1024;

// -----------------------------------------------------------------------------
// CORS + response helpers
// -----------------------------------------------------------------------------
function allowed(origin) {
  if (!origin) return null;
  const s = new Set([
    "https://stocksaathi.co.in",
    "https://www.stocksaathi.co.in",
    "http://localhost:7348",
    "http://127.0.0.1:7348",
  ]);
  if (s.has(origin)) return origin;
  if (origin.startsWith("https://") && origin.endsWith(".vercel.app")) return origin;
  return null;
}
function cors(origin, noStore = true) {
  const h = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": noStore ? "no-store" : "public, max-age=300",
    "X-Content-Type-Options": "nosniff",
  });
  const a = allowed(origin);
  if (a) { h.set("Access-Control-Allow-Origin", a); h.set("Vary", "Origin"); }
  return h;
}
function j(status, body, origin, noStore = true) {
  return new Response(JSON.stringify(body), { status, headers: cors(origin, noStore) });
}

// -----------------------------------------------------------------------------
// Supabase cache  (bucket + key -> payload)
// -----------------------------------------------------------------------------
async function supabaseReq(path, opts = {}) {
  const env = globalThis.process?.env || {};
  const url = env.SUPABASE_URL;
  const key = opts.serviceRole ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("supabase_not_configured");
  return fetch(`${url.replace(/\/$/, "")}${path}`, {
    ...opts,
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": opts.prefer || "return=representation",
      ...(opts.headers || {}),
    },
  });
}
function normalizeKey(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 400);
}
async function cacheGet(bucket, cacheKey) {
  try {
    const path = `/rest/v1/ai_response_cache?select=payload,display_key,created_at&bucket=eq.${encodeURIComponent(bucket)}&cache_key=eq.${encodeURIComponent(cacheKey)}&limit=1`;
    const res = await supabaseReq(path);
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows[0].payload;
  } catch { return null; }
}
function cachePut(bucket, cacheKey, display, payload) {
  supabaseReq("/rest/v1/ai_response_cache", {
    method: "POST",
    serviceRole: true,
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ bucket, cache_key: cacheKey, display_key: display || null, payload }),
  }).catch(() => {});
}

// -----------------------------------------------------------------------------
// LLM helper — talks directly to the same upstreams /api/chat supports,
// WITHOUT doing a /api/chat HTTP hop. Picks Gemini > OpenAI > Groq by
// availability. Honours a `profile` hint so fast lanes prefer Flash.
// -----------------------------------------------------------------------------
async function callLlm({ messages, temperature = 0.4, max_tokens = 400, response_format, profile = "reasoning" }) {
  const env = globalThis.process?.env || {};
  const providers = [];

  const geminiFastModel = env.GEMINI_FAST_MODEL || "gemini-3.1-flash";
  const geminiProModel = env.GEMINI_PRO_MODEL || "gemini-3.1-pro";
  const openaiModel = env.OPENAI_MODEL || "gpt-5.4";
  const groqModel = env.GROQ_MODEL || "llama-3.3-70b-versatile";

  // Order by profile — same logic as /api/chat.
  if (profile === "fast") {
    if (env.GEMINI_API_KEY) providers.push({ url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: env.GEMINI_API_KEY, model: geminiFastModel, label: "gemini_fast" });
    if (env.GROQ_API_KEY)   providers.push({ url: "https://api.groq.com/openai/v1/chat/completions", key: env.GROQ_API_KEY, model: groqModel, label: "groq" });
    if (env.GEMINI_API_KEY) providers.push({ url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: env.GEMINI_API_KEY, model: geminiProModel, label: "gemini_pro" });
    if (env.OPENAI_API_KEY) providers.push({ url: "https://api.openai.com/v1/chat/completions", key: env.OPENAI_API_KEY, model: openaiModel, label: "openai" });
  } else {
    // reasoning / json / creative — prefer Gemini Pro first (smart + fast),
    // OpenAI fallback, Gemini Flash, Groq floor.
    if (env.GEMINI_API_KEY) providers.push({ url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: env.GEMINI_API_KEY, model: geminiProModel, label: "gemini_pro" });
    if (env.OPENAI_API_KEY) providers.push({ url: "https://api.openai.com/v1/chat/completions", key: env.OPENAI_API_KEY, model: openaiModel, label: "openai" });
    if (env.GEMINI_API_KEY) providers.push({ url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: env.GEMINI_API_KEY, model: geminiFastModel, label: "gemini_fast" });
    if (env.GROQ_API_KEY)   providers.push({ url: "https://api.groq.com/openai/v1/chat/completions", key: env.GROQ_API_KEY, model: groqModel, label: "groq" });
  }
  if (!providers.length) throw new Error("no_provider_configured");

  let lastErr = null;
  for (const p of providers) {
    try {
      const body = { model: p.model, messages, temperature, max_tokens };
      if (response_format) body.response_format = response_format;
      const res = await fetch(p.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${p.key}`,
          "User-Agent": "StockSaathi-Edge/1.0",
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) { lastErr = `http_${res.status}`; continue; }
      if (!res.ok) { lastErr = `http_${res.status}`; continue; }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) { lastErr = "empty"; continue; }
      return text;
    } catch (e) {
      lastErr = e?.message || "fetch_failed";
    }
  }
  throw new Error(lastErr || "all_providers_failed");
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); }
  catch {
    // Strip Markdown fences the model might add despite response_format.
    const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (m) { try { return JSON.parse(m[1]); } catch {} }
    const first = text.indexOf("{"), last = text.lastIndexOf("}");
    if (first >= 0 && last > first) { try { return JSON.parse(text.slice(first, last + 1)); } catch {} }
    return null;
  }
}

function istDayKey() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function weekKey() {
  const d = new Date();
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  const weeks = Math.floor((d.getTime() - jan1) / (7 * 86400000));
  return `${d.getUTCFullYear()}_w${weeks}`;
}

async function sha12(text) {
  const buf = new TextEncoder().encode(String(text || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 400));
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

// -----------------------------------------------------------------------------
// op implementations
// -----------------------------------------------------------------------------

async function opCacheGet(req, origin, url) {
  const bucket = normalizeKey(url.searchParams.get("bucket"));
  const key = normalizeKey(url.searchParams.get("key"));
  if (!bucket || !key) return j(400, { error: "bad_params" }, origin);
  const payload = await cacheGet(bucket, key);
  if (!payload) return j(200, { payload: null, hit: false }, origin);
  return j(200, { payload, hit: true }, origin);
}

async function opCachePut(req, origin) {
  let body;
  try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const bucket = normalizeKey(body.bucket);
  const key = normalizeKey(body.key);
  if (!bucket || !key || body.payload == null) return j(400, { error: "bad_params" }, origin);
  cachePut(bucket, key, body.display || null, body.payload);
  return j(200, { ok: true }, origin);
}

// --- Finance-term explainer --------------------------------------------------
const SYSTEM_EXPLAIN = `You are Saathi, a finance coach for Indian teens. A user hovered over a financial term they don't know. Explain it in ONE sentence (20-30 words max). Plain English with an Indian-context example where natural (rupees, Nifty, SIP). No jargon cascade, no quotes around the term. Just the one-sentence definition, period.`;

async function opExplain(req, origin, url) {
  const term = (url.searchParams.get("term") || "").trim().slice(0, 60);
  if (!term) return j(400, { error: "missing_term" }, origin);
  const key = normalizeKey(term);
  const hit = await cacheGet("explain", key);
  if (hit?.explanation) return j(200, { explanation: hit.explanation, source: "cache" }, origin, false);
  try {
    const text = await callLlm({
      messages: [
        { role: "system", content: SYSTEM_EXPLAIN },
        { role: "user", content: `Explain "${term}" in one sentence.` },
      ],
      max_tokens: 120,
      temperature: 0.3,
      profile: "fast",
    });
    const explanation = text.trim().replace(/^["'""]|["'""]$/g, "").trim();
    if (!explanation) return j(502, { error: "empty" }, origin);
    cachePut("explain", key, term, { explanation });
    return j(200, { explanation, source: "fresh" }, origin, false);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- News sentiment + retail-angle TL;DR ------------------------------------
const SYSTEM_NEWS_TLDR = `You are Saathi. Given one news headline and optional related tickers, return strict JSON:
{ "sentiment": "bullish" | "bearish" | "neutral", "tldr": "<single sentence, ≤ 22 words, Indian retail context, no hedges>" }
Rules: sentiment is expected impact on the stocks; tldr is plain, useful, no "it depends". Return ONLY the JSON.`;

async function opNewsTldr(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const headline = String(body.headline || "").trim().slice(0, 300);
  if (!headline) return j(400, { error: "missing_headline" }, origin);
  const symbols = Array.isArray(body.symbols) ? body.symbols.filter(s => typeof s === "string").slice(0, 6) : [];
  const source = typeof body.source === "string" ? body.source.slice(0, 40) : "";

  const key = "h_" + await sha12(headline);
  const hit = await cacheGet("news_tldr", key);
  if (hit?.sentiment && hit?.tldr) return j(200, { ...hit, source: "cache" }, origin);

  const userMsg = [
    `Headline: ${headline}`,
    source ? `Source: ${source}` : null,
    symbols.length ? `Related tickers: ${symbols.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_NEWS_TLDR }, { role: "user", content: userMsg }],
      max_tokens: 180, temperature: 0.3, response_format: { type: "json_object" }, profile: "fast",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const sentiment = ["bullish", "bearish", "neutral"].includes(parsed.sentiment) ? parsed.sentiment : "neutral";
    const tldr = typeof parsed.tldr === "string" && parsed.tldr.trim() ? parsed.tldr.trim().slice(0, 200) : "";
    if (!tldr) return j(502, { error: "no_tldr" }, origin);
    const out = { sentiment, tldr };
    cachePut("news_tldr", key, headline, out);
    return j(200, { ...out, source: "fresh" }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Portfolio daily digest --------------------------------------------------
const SYSTEM_PORTFOLIO = `You are Saathi. Look at the structured portfolio snapshot and write a 60-90 word paragraph in second person ("your portfolio…"). Return strict JSON:
{ "narrative": "...", "mood": "up" | "down" | "flat" | "empty" }
Rules: quote exact numbers, name the biggest mover, flag > 40% concentration and > 50% cash-idle neutrally, no emojis, no markdown, no buy/sell advice, warm + sharp tone. If holdings empty, encourage first trade warmly.`;

async function opPortfolioDigest(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  if (typeof body.totalRupees !== "number") return j(400, { error: "bad_payload" }, origin);
  const holdings = Array.isArray(body.holdings) ? body.holdings.slice(0, 15) : [];
  const userMsg = [
    `Total: ₹${body.totalRupees.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
    `Since start: ${body.deltaPct >= 0 ? "+" : ""}${Number(body.deltaPct).toFixed(2)}%`,
    `Cash: ₹${Number(body.cashRupees).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
    holdings.length === 0
      ? `Holdings: none yet.`
      : `Holdings:\n${holdings.map(h => `  ${h.symbol} (${h.name}, ${h.sector}) — ${h.qty} units, avg ₹${Number(h.avgRupees).toFixed(2)}, now ₹${Number(h.curRupees).toFixed(2)}, day ${h.dayPct >= 0 ? "+" : ""}${Number(h.dayPct).toFixed(2)}%, P/L ${h.plPct >= 0 ? "+" : ""}${(Number(h.plPct) * 100).toFixed(2)}%`).join("\n")}`,
  ].join("\n");
  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_PORTFOLIO }, { role: "user", content: userMsg }],
      max_tokens: 260, temperature: 0.4, response_format: { type: "json_object" }, profile: "reasoning",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const narrative = typeof parsed.narrative === "string" ? parsed.narrative.trim().slice(0, 800) : "";
    const mood = ["up", "down", "flat", "empty"].includes(parsed.mood) ? parsed.mood : (holdings.length === 0 ? "empty" : body.deltaPct > 1 ? "up" : body.deltaPct < -1 ? "down" : "flat");
    if (!narrative) return j(502, { error: "no_narrative" }, origin);
    return j(200, { narrative, mood }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Why is X moving today? --------------------------------------------------
const SYSTEM_STOCK_WHY = `You are Saathi. Write a 50-80 word paragraph explaining why a stock is moving today. Open with the numbers (ticker + price + today's %). Tie the move to the provided headlines when possible; if nothing explains it, say sector rotation / macro / profit-booking plainly. End with one thing to watch. No predictions or buy/sell advice, Indian retail context. Return strict JSON: { "explanation": "..." }.`;

async function opStockWhy(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const sym = String(body.symbol || "").toUpperCase().slice(0, 24);
  if (!sym) return j(400, { error: "missing_symbol" }, origin);
  const changePct = Number(body.changePct) || 0;
  const dir = changePct >= 0 ? "up" : "down";
  const key = `${sym.toLowerCase()}_${dir}_${istDayKey()}`;
  const hit = await cacheGet("stock_why", key);
  if (hit?.explanation) return j(200, { explanation: hit.explanation, source: "cache" }, origin);

  const news = Array.isArray(body.newsItems) ? body.newsItems.slice(0, 8) : [];
  const userMsg = [
    `Ticker: ${sym}`,
    body.name ? `Name: ${body.name}` : null,
    body.sector ? `Sector: ${body.sector}` : null,
    body.pricePaise != null ? `Price: ₹${(body.pricePaise / 100).toFixed(2)}` : null,
    `Today's move: ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`,
    news.length ? `\nRecent related headlines:\n${news.map(n => `- [${n.source || "?"}] ${n.headline}`).join("\n")}` : "No specific headlines on this ticker found today.",
  ].filter(Boolean).join("\n");

  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_STOCK_WHY }, { role: "user", content: userMsg }],
      max_tokens: 240, temperature: 0.35, response_format: { type: "json_object" }, profile: "reasoning",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const explanation = typeof parsed.explanation === "string" ? parsed.explanation.trim().slice(0, 700) : "";
    if (!explanation) return j(502, { error: "no_explanation" }, origin);
    cachePut("stock_why", key, sym, { explanation });
    return j(200, { explanation, source: "fresh" }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Pre-trade nudge ---------------------------------------------------------
const SYSTEM_TRADE_NUDGE = `You are Saathi. Before a trade, write a tight 40-60 word observation about ONE meaningful thing for this specific trade given the user's portfolio state. Flag concentration > 35%, cash drain < 10%, sector > 50%, doubling down on losing positions (> 10% down already), or first-trade milestones. Otherwise say something genuinely neutral ("looks reasonable for your size"). NEVER say should buy / should sell / recommend / target price. One warm honest paragraph; if you flag a concern give the reason in the same sentence. Return strict JSON: { "nudge": "...", "severity": "neutral" | "note" | "warn" }.`;

async function opTradeNudge(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  if (!body?.action || !body?.symbol) return j(400, { error: "bad_payload" }, origin);
  const pf = body.portfolio || {};
  const cashPct = pf.totalRupees ? (pf.cashRupees / pf.totalRupees) * 100 : 0;
  const userMsg = [
    `Action: ${body.action}`,
    `Ticker: ${body.symbol} (${body.name || ""}, ${body.sector || ""})`,
    `Qty: ${body.qty}`,
    `Price per share: ₹${Number(body.priceRupees || 0).toFixed(2)}`,
    `Trade value: ₹${(Number(body.qty) * Number(body.priceRupees)).toFixed(2)}`,
    ``,
    `Before-trade portfolio:`,
    `  Total: ₹${Number(pf.totalRupees || 0).toLocaleString("en-IN")}`,
    `  Cash: ₹${Number(pf.cashRupees || 0).toLocaleString("en-IN")} (${cashPct.toFixed(0)}%)`,
    pf.existingQty ? `  Already owns ${pf.existingQty} units at avg ₹${Number(pf.existingAvgRupees).toFixed(2)}, currently ${pf.existingPlPct >= 0 ? "+" : ""}${(pf.existingPlPct * 100).toFixed(1)}% P/L` : `  Doesn't own this ticker yet`,
    pf.tradeCountInSymbol != null ? `  Trades in this ticker so far: ${pf.tradeCountInSymbol}` : null,
    pf.totalTradeCount != null ? `  Total trades ever: ${pf.totalTradeCount}` : null,
    pf.sectorAllocPct != null ? `  Current ${body.sector} sector weight: ${Number(pf.sectorAllocPct).toFixed(0)}%` : null,
  ].filter(Boolean).join("\n");
  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_TRADE_NUDGE }, { role: "user", content: userMsg }],
      max_tokens: 220, temperature: 0.4, response_format: { type: "json_object" }, profile: "fast",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const nudge = typeof parsed.nudge === "string" ? parsed.nudge.trim().slice(0, 500) : "";
    const severity = ["neutral", "note", "warn"].includes(parsed.severity) ? parsed.severity : "neutral";
    if (!nudge) return j(502, { error: "no_nudge" }, origin);
    return j(200, { nudge, severity }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Market mood -------------------------------------------------------------
const SYSTEM_MOOD = `You are Saathi. Summarise today's Indian stock market in one 50-70 word paragraph for a teen investor. Use the sector data sent. Call out 2-3 most notable sector moves by name. Give a one-word overall temperature (hot / warm / mild / cold). Plain prose, Indian context, no emojis, no markdown, no predictions. Return strict JSON: { "narrative": "...", "temperature": "hot"|"warm"|"mild"|"cold" }.`;

async function opMarketMood(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const sectors = Array.isArray(body.sectors) ? body.sectors.slice(0, 12) : [];
  if (!sectors.length) return j(400, { error: "no_sectors" }, origin);
  const sig = sectors.slice(0, 6).map(s => `${String(s.name).toLowerCase().slice(0, 10)}:${(Number(s.avgPct) || 0).toFixed(1)}`).join("|");
  const key = `${istDayKey()}_${sig}`;
  const hit = await cacheGet("market_mood", key);
  if (hit?.narrative) return j(200, { ...hit, source: "cache" }, origin);

  const userMsg = [
    `Today (${istDayKey()}) Indian market sector moves:`,
    ...sectors.map(s => `  ${s.name}: avg ${s.avgPct >= 0 ? "+" : ""}${Number(s.avgPct).toFixed(2)}% across ${s.count} names (top up: ${s.topUp || "-"}, top down: ${s.topDown || "-"})`),
  ].join("\n");

  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_MOOD }, { role: "user", content: userMsg }],
      max_tokens: 200, temperature: 0.35, response_format: { type: "json_object" }, profile: "fast",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const narrative = typeof parsed.narrative === "string" ? parsed.narrative.trim().slice(0, 500) : "";
    const temperature = ["hot", "warm", "mild", "cold"].includes(parsed.temperature) ? parsed.temperature : "mild";
    if (!narrative) return j(502, { error: "no_narrative" }, origin);
    const out = { narrative, temperature };
    cachePut("market_mood", key, null, out);
    return j(200, { ...out, source: "fresh" }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Market natural-language search ------------------------------------------
const SYSTEM_NL_SEARCH = `You are Saathi helping a teen filter a universe of Indian stocks. Return strict JSON: { "matches": ["TICKER", ...], "rationale": "<one sentence>" }.
Rules: pick 3-12 tickers FROM the provided candidate list only (no invention); order by closeness-to-intent; rationale 15-25 words. If no candidates fit return matches:[] with a plain rationale.`;

async function opMarketSearch(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const query = String(body.query || "").trim().slice(0, 200);
  if (!query) return j(400, { error: "missing_query" }, origin);
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 200) : [];
  if (!candidates.length) return j(400, { error: "no_candidates" }, origin);

  const key = `${normalizeKey(query)}_${istDayKey()}`;
  const hit = await cacheGet("nl_search", key);
  if (hit?.matches) return j(200, { ...hit, source: "cache" }, origin);

  const table = candidates.map(c => `${c.symbol} | ${c.name} | ${c.sector || ""} | mcap:${c.marketCap || ""} | pe:${c.pe ?? ""} | pb:${c.pb ?? ""} | div:${c.divYield ?? ""} | beta:${c.beta ?? ""} | risk:${c.risk || ""} | today:${c.dayPct != null ? Number(c.dayPct).toFixed(2) + "%" : ""}`).join("\n");
  const userMsg = `Query: ${query}\n\nCandidates:\n${table}`;

  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_NL_SEARCH }, { role: "user", content: userMsg }],
      max_tokens: 400, temperature: 0.2, response_format: { type: "json_object" }, profile: "reasoning",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const valid = new Set(candidates.map(c => c.symbol));
    const matches = Array.isArray(parsed.matches) ? parsed.matches.filter(s => typeof s === "string" && valid.has(s)).slice(0, 15) : [];
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim().slice(0, 280) : "";
    const out = { matches, rationale };
    cachePut("nl_search", key, query, out);
    return j(200, { ...out, source: "fresh" }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Report card narrative ---------------------------------------------------
const SYSTEM_REPORT = `You are Saathi writing a student's behavioural-investing report card. From the stats and bias flags return strict JSON:
{ "narrative": "<80-120 words, second person, specific to the numbers>", "strengths": ["3 ≤10-word items"], "watchouts": ["3 ≤10-word items"] }
Quote the actual numbers. 3 strengths + 3 watch-outs, substantive not fluff. No emojis, no markdown, no buy/sell advice, teen-readable English, dry-honest > diplomatic.`;

async function opReportCard(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const userMsg = [
    `Started: ${body.startedAt || "recently"}`,
    `Total trades: ${body.totalTrades || 0}`,
    `Win rate: ${((body.winRate || 0) * 100).toFixed(0)}%`,
    `Biggest win: ₹${body.biggestWin || 0}`,
    `Biggest loss: ₹${body.biggestLoss || 0}`,
    `Avg hold time: ${body.avgHoldDays || 0} days`,
    `Portfolio return: ${body.portfolioReturnPct >= 0 ? "+" : ""}${Number(body.portfolioReturnPct || 0).toFixed(2)}%`,
    `Top sectors: ${(body.topSectors || []).join(", ") || "none yet"}`,
    `Bias flags raised: ${(body.biasFlags || []).length ? (body.biasFlags || []).join(", ") : "none"}`,
  ].join("\n");
  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_REPORT }, { role: "user", content: userMsg }],
      max_tokens: 360, temperature: 0.45, response_format: { type: "json_object" }, profile: "reasoning",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const narrative = typeof parsed.narrative === "string" ? parsed.narrative.trim().slice(0, 1000) : "";
    const strengths = Array.isArray(parsed.strengths) ? parsed.strengths.filter(x => typeof x === "string").slice(0, 5).map(x => x.slice(0, 120)) : [];
    const watchouts = Array.isArray(parsed.watchouts) ? parsed.watchouts.filter(x => typeof x === "string").slice(0, 5).map(x => x.slice(0, 120)) : [];
    if (!narrative) return j(502, { error: "no_narrative" }, origin);
    return j(200, { narrative, strengths, watchouts }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Crash-replay suggestions ------------------------------------------------
const SYSTEM_CRASH_SUGG = `Return strict JSON: { "suggestions": ["...", "...", ...] }
10 short (4-7 word) phrases a teen might type into a "describe any Indian market event" input. Mix famous events, niche events, colloquial phrasings, decades, sectors. Indian context only. No duplicates, no emojis, no buy/sell advice. Generate fresh phrases.`;

async function opCrashSuggestions(req, origin) {
  const key = weekKey();
  const hit = await cacheGet("crash_sugg", key);
  if (hit?.suggestions?.length) return j(200, { ...hit, source: "cache" }, origin, false);
  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_CRASH_SUGG }, { role: "user", content: "Generate 10 suggestions." }],
      max_tokens: 300, temperature: 0.8, response_format: { type: "json_object" }, profile: "fast",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter(s => typeof s === "string" && s.trim().length >= 3).slice(0, 12).map(s => s.trim().slice(0, 80)) : [];
    if (!suggestions.length) return j(502, { error: "no_suggestions" }, origin);
    const out = { suggestions };
    cachePut("crash_sugg", key, null, out);
    return j(200, { ...out, source: "fresh" }, origin, false);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// --- Command router (Command-K) ---------------------------------------------
const SYSTEM_COMMAND = `You are Saathi's command router on StockSaathi. A user types a command or question. Return strict JSON:
  { "action": "navigate", "target": "<hash path like /portfolio or /stocks/TCS>", "response": "<short ack>" }
  { "action": "answer",   "response": "<60-120 word answer in Saathi voice>" }
  { "action": "search",   "query": "<the search intent>", "response": "<short ack>" }
  { "action": "trade",    "side": "BUY" | "SELL", "symbol": "<NSE ticker>", "qty": <int>, "response": "<short ack>" }

Navigation targets: /portfolio /stocks /news /chat /crash-replay /leaderboard /friends /report-card /settings /stocks/<TICKER>
Rules: educational → answer (Saathi voice, Indian teen audience, no emojis, no buy/sell advice). Go somewhere → navigate. Filter stocks → search. Place trade → trade (qty ≥ 1). Garbage/off-scope → answer + brief redirect. Return ONLY the JSON.`;

async function opCommand(req, origin) {
  let body; try { body = await req.json(); } catch { return j(400, { error: "bad_body" }, origin); }
  const query = String(body.query || "").trim().slice(0, 400);
  if (!query) return j(400, { error: "missing_query" }, origin);
  const context = String(body.context || "").slice(0, 200);
  const userMsg = context ? `Current page: ${context}\nCommand: ${query}` : `Command: ${query}`;
  try {
    const text = await callLlm({
      messages: [{ role: "system", content: SYSTEM_COMMAND }, { role: "user", content: userMsg }],
      max_tokens: 400, temperature: 0.2, response_format: { type: "json_object" }, profile: "reasoning",
    });
    const parsed = parseJsonLoose(text);
    if (!parsed) return j(502, { error: "non_json" }, origin);
    return j(200, parsed, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------
export default async function handler(req) {
  const origin = req.headers.get("Origin") || "";
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    const h = cors(origin);
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type");
    h.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers: h });
  }
  if (origin && !allowed(origin)) return j(403, { error: "forbidden_origin" }, origin);

  const cl = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (cl > MAX_BODY) return j(413, { error: "payload_too_large" }, origin);

  const op = url.searchParams.get("op");
  if (!op) return j(400, { error: "missing_op" }, origin);

  try {
    switch (op) {
      case "cache-get":           return await opCacheGet(req, origin, url);
      case "cache-put":           if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opCachePut(req, origin);
      case "explain":             return await opExplain(req, origin, url);
      case "news-tldr":           if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opNewsTldr(req, origin);
      case "portfolio-digest":    if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opPortfolioDigest(req, origin);
      case "stock-why":           if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opStockWhy(req, origin);
      case "trade-nudge":         if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opTradeNudge(req, origin);
      case "market-mood":         if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opMarketMood(req, origin);
      case "market-search":       if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opMarketSearch(req, origin);
      case "report-card":         if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opReportCard(req, origin);
      case "crash-suggestions":   return await opCrashSuggestions(req, origin);
      case "command":             if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin); return await opCommand(req, origin);
      case "time":                return opTime(req, origin);
      default: return j(400, { error: "unknown_op", op }, origin);
    }
  } catch (e) {
    return j(500, { error: "handler_exception", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// op: time — tiny, authoritative server time. The client uses this to
// compute an offset so the market-open / market-closed badge can't be
// faked by changing the user's system clock.
// -----------------------------------------------------------------------------
function opTime(req, origin) {
  return j(200, { ms: Date.now() }, origin);
}
