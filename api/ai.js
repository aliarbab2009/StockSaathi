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
      case "signup-count":        return await opSignupCount(req, origin);
      case "admin-overview":      return await opAdminOverview(req, origin);
      case "admin-user":          return await opAdminUser(req, origin, url);
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

// -----------------------------------------------------------------------------
// Admin gate — the admin ops require a bearer token that matches the
// ADMIN_TOKEN env var set on Vercel. Set once, paste into the admin
// panel, stored in localStorage. Treats unset ADMIN_TOKEN as
// 'admin disabled' to prevent an empty-token bypass.
// -----------------------------------------------------------------------------
function checkAdmin(req) {
  const env = globalThis.process?.env || {};
  const expected = (env.ADMIN_TOKEN || "").trim();
  if (!expected) return { ok: false, reason: "admin_disabled" };
  const hdr = req.headers.get("Authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : hdr.trim();
  if (!token) return { ok: false, reason: "missing_token" };
  // Constant-time-ish compare.
  if (token.length !== expected.length) return { ok: false, reason: "bad_token" };
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: "bad_token" };
}

async function sbAdminFetch(path, opts = {}) {
  const env = globalThis.process?.env || {};
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("supabase_not_configured");
  return fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}${path}`, {
    ...opts,
    headers: {
      "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

async function opAdminOverview(req, origin) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);

  // IST day-buckets for 30-day chart
  const days = 30;
  const buckets = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
    buckets[`${parts.year}-${parts.month}-${parts.day}`] = 0;
  }

  try {
    const [profilesRes, portsRes, txsRes, coachRes] = await Promise.all([
      sbAdminFetch(`/rest/v1/profiles?select=id,username,display_name,email,age,school,city,risk_profile,onboarded,parent_consent_at,created_at&order=created_at.desc&limit=500`),
      sbAdminFetch(`/rest/v1/portfolios?select=user_id,cash_paise,starting_cash_paise,updated_at&limit=2000`),
      sbAdminFetch(`/rest/v1/transactions?select=user_id,symbol,side,qty,price_paise,ts&order=ts.desc&limit=5000`),
      sbAdminFetch(`/rest/v1/coach_messages?select=user_id&limit=10000`),
    ]);
    const profiles = profilesRes.ok ? await profilesRes.json() : [];
    const ports = portsRes.ok ? await portsRes.json() : [];
    const txs = txsRes.ok ? await txsRes.json() : [];
    const coachMessages = coachRes.ok ? await coachRes.json() : [];

    const portByUser = {};
    for (const p of ports) portByUser[p.user_id] = p;
    const tradeCountByUser = {};
    const lastTradeByUser = {};
    for (const t of txs) {
      tradeCountByUser[t.user_id] = (tradeCountByUser[t.user_id] || 0) + 1;
      if (!lastTradeByUser[t.user_id]) lastTradeByUser[t.user_id] = t.ts;
    }
    const coachCountByUser = {};
    for (const m of coachMessages) coachCountByUser[m.user_id] = (coachCountByUser[m.user_id] || 0) + 1;

    // Populate 30-day sign-up chart
    for (const p of profiles) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(p.created_at)).reduce((a, pp) => (a[pp.type] = pp.value, a), {});
      const k = `${parts.year}-${parts.month}-${parts.day}`;
      if (k in buckets) buckets[k]++;
    }
    const byDay = Object.entries(buckets).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, count]) => ({ day, count }));

    const users = profiles.map(p => {
      const port = portByUser[p.id];
      return {
        id: p.id,
        username: p.username,
        displayName: p.display_name,
        email: p.email,
        age: p.age,
        school: p.school,
        city: p.city,
        riskProfile: p.risk_profile,
        onboarded: p.onboarded,
        parentConsented: !!p.parent_consent_at,
        createdAt: p.created_at,
        cashRupees: port ? Math.round((port.cash_paise || 0) / 100) : null,
        startingCashRupees: port ? Math.round((port.starting_cash_paise || 10000000) / 100) : 100000,
        lastActive: port?.updated_at || p.created_at,
        tradeCount: tradeCountByUser[p.id] || 0,
        coachMsgCount: coachCountByUser[p.id] || 0,
        lastTradeAt: lastTradeByUser[p.id] || null,
      };
    });

    const totalCash = users.reduce((a, u) => a + (u.cashRupees || 0), 0);
    const onboardedCount = users.filter(u => u.onboarded).length;
    const activeCount = users.filter(u => u.tradeCount > 0).length;

    return j(200, {
      aggregates: {
        users: users.length,
        onboarded: onboardedCount,
        onboardedPct: users.length ? Math.round((onboardedCount / users.length) * 100) : 0,
        active: activeCount,
        totalCashRupees: totalCash,
        totalTrades: txs.length,
        totalCoachMessages: coachMessages.length,
      },
      byDay,
      users,
      asOf: new Date().toISOString(),
    }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

async function opAdminUser(req, origin, url) {
  const gate = checkAdmin(req);
  if (!gate.ok) return j(401, { error: gate.reason }, origin);
  const userId = url.searchParams.get("id");
  if (!userId) return j(400, { error: "missing_id" }, origin);

  try {
    const [profRes, portRes, holdRes, txRes, coachRes, histRes] = await Promise.all([
      sbAdminFetch(`/rest/v1/profiles?select=*&id=eq.${encodeURIComponent(userId)}&limit=1`),
      sbAdminFetch(`/rest/v1/portfolios?select=*&user_id=eq.${encodeURIComponent(userId)}&limit=1`),
      sbAdminFetch(`/rest/v1/holdings?select=symbol,qty,avg_cost_paise,first_bought_at&user_id=eq.${encodeURIComponent(userId)}&limit=200`),
      sbAdminFetch(`/rest/v1/transactions?select=*&user_id=eq.${encodeURIComponent(userId)}&order=ts.desc&limit=200`),
      sbAdminFetch(`/rest/v1/coach_messages?select=ts,event_type,trigger_symbol,model&user_id=eq.${encodeURIComponent(userId)}&order=ts.desc&limit=200`),
      sbAdminFetch(`/rest/v1/portfolio_history?select=ts,value_paise&user_id=eq.${encodeURIComponent(userId)}&order=ts.asc&limit=500`),
    ]);
    const profile = profRes.ok ? (await profRes.json())[0] : null;
    const portfolio = portRes.ok ? (await portRes.json())[0] : null;
    const holdings = holdRes.ok ? await holdRes.json() : [];
    const transactions = txRes.ok ? await txRes.json() : [];
    const coachMessages = coachRes.ok ? await coachRes.json() : [];
    const portfolioHistory = histRes.ok ? await histRes.json() : [];
    if (!profile) return j(404, { error: "not_found" }, origin);
    return j(200, { profile, portfolio, holdings, transactions, coachMessages, portfolioHistory }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 120) }, origin);
  }
}

// -----------------------------------------------------------------------------
// op: signup-count — how many new profiles landed today (IST), this week, all-time.
// Uses SUPABASE_SERVICE_ROLE_KEY to bypass RLS on profiles. Public-read
// numeric count only — no PII leaked.
// -----------------------------------------------------------------------------
async function opSignupCount(req, origin) {
  const env = globalThis.process?.env || {};
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return j(501, { error: "supabase_not_configured" }, origin);
  }

  const url = new URL(req.url);
  const detailed = url.searchParams.get("detailed") === "1";
  const days = Math.max(1, Math.min(60, parseInt(url.searchParams.get("days") || "14", 10)));

  // IST day-start for "today" in UTC
  const nowIst = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  const istDayStartIso = `${nowIst.year}-${nowIst.month}-${nowIst.day}T00:00:00+05:30`;
  const weekAgoIso = new Date(Date.now() - 7 * 86400000).toISOString();
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

  async function sbFetch(path) {
    return fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}${path}`, {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
  }

  async function count(filter) {
    const r = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/profiles?select=id${filter ? "&" + filter : ""}`, {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "count=exact",
        "Range-Unit": "items",
        "Range": "0-0",
      },
    });
    const cr = r.headers.get("content-range") || "";
    const m = cr.match(/\/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  try {
    const [today, week, total] = await Promise.all([
      count(`created_at=gte.${encodeURIComponent(istDayStartIso)}`),
      count(`created_at=gte.${encodeURIComponent(weekAgoIso)}`),
      count(""),
    ]);

    // Day-by-day breakdown (last N days, IST-bucketed)
    const recentRes = await sbFetch(`/rest/v1/profiles?select=id,created_at&created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=2000`);
    const recentRows = recentRes.ok ? await recentRes.json() : [];
    const byDay = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
      byDay[`${parts.year}-${parts.month}-${parts.day}`] = 0;
    }
    for (const row of recentRows) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date(row.created_at)).reduce((a, p) => (a[p.type] = p.value, a), {});
      const k = `${parts.year}-${parts.month}-${parts.day}`;
      if (k in byDay) byDay[k]++;
    }
    const byDayArr = Object.entries(byDay)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, count]) => ({ day, count }));

    const base = { today, week, total, byDay: byDayArr, asOf: new Date().toISOString() };
    if (!detailed) return j(200, base, origin);

    // Detailed mode — include the actual user rows (capped) + aggregate
    // stats per user. Server-role only; anyone hitting ?detailed=1 gets
    // real PII, so consider gating with a shared admin token before you
    // expose this beyond your own dashboard.
    const profilesRes = await sbFetch(`/rest/v1/profiles?select=id,username,display_name,email,age,school,city,risk_profile,onboarded,created_at,parent_consent_at&order=created_at.desc&limit=200`);
    const profiles = profilesRes.ok ? await profilesRes.json() : [];

    const portRes = await sbFetch(`/rest/v1/portfolios?select=user_id,cash_paise,starting_cash_paise,updated_at&limit=2000`);
    const ports = portRes.ok ? await portRes.json() : [];
    const portByUser = {};
    for (const p of ports) portByUser[p.user_id] = p;

    const txRes = await sbFetch(`/rest/v1/transactions?select=user_id&limit=5000`);
    const txs = txRes.ok ? await txRes.json() : [];
    const tradeCountByUser = {};
    for (const t of txs) tradeCountByUser[t.user_id] = (tradeCountByUser[t.user_id] || 0) + 1;

    const users = profiles.map(p => ({
      id: p.id,
      username: p.username,
      displayName: p.display_name,
      email: p.email,
      age: p.age,
      school: p.school,
      city: p.city,
      riskProfile: p.risk_profile,
      onboarded: p.onboarded,
      parentConsented: !!p.parent_consent_at,
      createdAt: p.created_at,
      cashRupees: portByUser[p.id] ? Math.round((portByUser[p.id].cash_paise || 0) / 100) : null,
      startingCashRupees: portByUser[p.id] ? Math.round((portByUser[p.id].starting_cash_paise || 100000) / 100) : 100000,
      tradeCount: tradeCountByUser[p.id] || 0,
      lastActive: portByUser[p.id]?.updated_at || p.created_at,
    }));

    return j(200, { ...base, users }, origin);
  } catch (e) {
    return j(502, { error: "query_failed", detail: String(e.message).slice(0, 100) }, origin);
  }
}
