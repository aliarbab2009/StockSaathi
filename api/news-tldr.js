// =============================================================================
// /api/news-tldr  —  Per-headline AI sentiment + retail-angle one-liner.
//
// POST body: { headline, source, symbols }  (symbols optional)
// Returns:   { sentiment: "bullish"|"bearish"|"neutral", tldr: "…", source: "cache"|"fresh" }
//
// Cache-first. Once a headline has been analysed, every subsequent user
// viewing the same news item gets the tag instantly for zero LLM cost.
// =============================================================================

export const config = { runtime: "edge" };

const MAX_HEADLINE = 300;

function allowed(origin) {
  if (!origin) return null;
  const set = new Set([
    "https://stocksaathi.co.in",
    "https://www.stocksaathi.co.in",
    "http://localhost:7348",
    "http://127.0.0.1:7348",
  ]);
  if (set.has(origin)) return origin;
  if (origin.startsWith("https://") && origin.endsWith(".vercel.app")) return origin;
  return null;
}

function cors(origin) {
  const h = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  const a = allowed(origin);
  if (a) { h.set("Access-Control-Allow-Origin", a); h.set("Vary", "Origin"); }
  return h;
}

function j(status, body, origin) {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) });
}

function baseUrl() {
  const v = globalThis.process?.env?.VERCEL_URL;
  return v ? `https://${v}` : "https://stocksaathi.co.in";
}

// Cheap stable hash for the headline — we only need uniqueness per story,
// not cryptographic strength. Matches between identical headlines across
// Moneycontrol / ET / LiveMint also benefit from hitting the same cache row.
async function keyForHeadline(h) {
  const text = String(h || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return "h_" + Array.from(new Uint8Array(hash)).slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function cacheGet(key) {
  try {
    const r = await fetch(baseUrl() + `/api/ai-cache?bucket=news_tldr&key=${encodeURIComponent(key)}`, {
      headers: { "Origin": "https://stocksaathi.co.in" },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.hit ? d.payload : null;
  } catch { return null; }
}

function cachePut(key, display, payload) {
  // fire-and-forget
  fetch(baseUrl() + "/api/ai-cache", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://stocksaathi.co.in" },
    body: JSON.stringify({ bucket: "news_tldr", key, display, payload }),
  }).catch(() => {});
}

const SYSTEM = `You are Saathi, a finance coach for Indian teens. You'll receive one news headline and (optionally) related stock tickers. Return a strict JSON object describing what this headline means for a retail investor in India.

Return exactly:
{
  "sentiment": "bullish" | "bearish" | "neutral",
  "tldr": "<single sentence, ≤ 22 words, plain English, Indian retail context, no hedges>"
}

Rules:
- sentiment is the EXPECTED impact on the named stocks (or on the Indian market at large if no specific stocks).
- tldr must be tight and useful. No "this could mean", no "it depends". If it's genuinely ambiguous, say so — once.
- No predictions of exact prices. No buy/sell advice. No emojis.
- Return ONLY the JSON object, no prose.`;

async function callChat(headline, symbols, source) {
  const userMsg = [
    `Headline: ${headline}`,
    source ? `Source: ${source}` : null,
    symbols && symbols.length ? `Related tickers: ${symbols.slice(0, 6).join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const res = await fetch(baseUrl() + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://stocksaathi.co.in" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userMsg },
      ],
      max_tokens: 180,
      temperature: 0.3,
      response_format: { type: "json_object" },
      profile: "fast",
    }),
  });
  if (!res.ok) throw new Error(`chat_http_${res.status}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error("empty");
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("non_json"); }
  const sentiment = ["bullish", "bearish", "neutral"].includes(parsed.sentiment) ? parsed.sentiment : "neutral";
  const tldr = typeof parsed.tldr === "string" && parsed.tldr.trim() ? parsed.tldr.trim().slice(0, 200) : "";
  if (!tldr) throw new Error("no_tldr");
  return { sentiment, tldr };
}

export default async function handler(req) {
  const origin = req.headers.get("Origin") || "";
  if (origin && !allowed(origin)) return j(403, { error: "forbidden_origin" }, origin);

  if (req.method === "OPTIONS") {
    const h = cors(origin);
    h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type");
    return new Response(null, { status: 204, headers: h });
  }
  if (req.method !== "POST") return j(405, { error: "method_not_allowed" }, origin);

  let body;
  try { body = await req.json(); }
  catch { return j(400, { error: "bad_body" }, origin); }

  const headline = String(body.headline || "").trim().slice(0, MAX_HEADLINE);
  if (!headline) return j(400, { error: "missing_headline" }, origin);
  const symbols = Array.isArray(body.symbols) ? body.symbols.filter(s => typeof s === "string").slice(0, 10) : [];
  const source = typeof body.source === "string" ? body.source.slice(0, 40) : "";

  const key = await keyForHeadline(headline);
  const cached = await cacheGet(key);
  if (cached?.sentiment && cached?.tldr) {
    return j(200, { ...cached, source: "cache" }, origin);
  }

  try {
    const out = await callChat(headline, symbols, source);
    cachePut(key, headline, out);
    return j(200, { ...out, source: "fresh" }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 100) }, origin);
  }
}
