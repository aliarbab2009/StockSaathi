// =============================================================================
// /api/explain  —  Finance-term micro-explainer.
//
// GET /api/explain?term=P/E
//
// Returns { explanation: "...", source: "cache" | "fresh" }
// Always cache-first. Explanations don't change over time so one generation
// per unique term serves every user of the site forever.
// =============================================================================

export const config = { runtime: "edge" };

const MAX_TERM_LEN = 60;

const env = () => globalThis.process?.env || {};

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
    "Cache-Control": "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
  const a = allowed(origin);
  if (a) { h.set("Access-Control-Allow-Origin", a); h.set("Vary", "Origin"); }
  return h;
}

function j(status, body, origin) {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) });
}

function normalize(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 100);
}

const SYSTEM = `You are Saathi, a finance coach for Indian teens (13-18). A user hovered over a financial or investing term they don't know. Explain it in ONE sentence — 20-30 words max. Plain English with an Indian-context example where natural (rupees, Nifty, SIP). No jargon cascades. No "it's complicated". No markdown, no bullets, no quotes around the term itself. Just the one-sentence definition, period.`;

const origin_of = (req) => req.headers.get("Origin") || "";

async function fromCache(origin, key, term) {
  try {
    const u = new URL(req_origin_base() + `/api/ai-cache?bucket=explain&key=${encodeURIComponent(key)}`);
    const r = await fetch(u, { headers: { "Origin": "https://stocksaathi.co.in" } });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.hit ? d.payload : null;
  } catch { return null; }
}

function req_origin_base() {
  const e = env();
  return e.VERCEL_URL ? `https://${e.VERCEL_URL}` : "https://stocksaathi.co.in";
}

async function writeCache(key, term, payload) {
  try {
    await fetch(req_origin_base() + "/api/ai-cache", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://stocksaathi.co.in" },
      body: JSON.stringify({ bucket: "explain", key, display: term, payload }),
    });
  } catch {}
}

async function callChat(term) {
  const res = await fetch(req_origin_base() + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": "https://stocksaathi.co.in" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Explain "${term}" in one sentence.` },
      ],
      max_tokens: 120,
      temperature: 0.3,
      profile: "fast",
    }),
  });
  if (!res.ok) throw new Error(`chat_http_${res.status}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("empty");
  return text.replace(/^["'""]|["'""]$/g, "").trim();
}

export default async function handler(req) {
  const origin = origin_of(req);
  if (origin && !allowed(origin)) return j(403, { error: "forbidden_origin" }, origin);

  if (req.method === "OPTIONS") {
    const h = cors(origin);
    h.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type");
    return new Response(null, { status: 204, headers: h });
  }
  if (req.method !== "GET") return j(405, { error: "method_not_allowed" }, origin);

  const term = (new URL(req.url).searchParams.get("term") || "").trim().slice(0, MAX_TERM_LEN);
  if (!term) return j(400, { error: "missing_term" }, origin);
  const key = normalize(term);
  if (!key) return j(400, { error: "bad_term" }, origin);

  const cached = await fromCache(origin, key, term);
  if (cached?.explanation) {
    return j(200, { explanation: cached.explanation, source: "cache" }, origin);
  }

  try {
    const explanation = await callChat(term);
    const payload = { explanation };
    // Fire-and-forget the cache write so the response doesn't wait.
    writeCache(key, term, payload);
    return j(200, { explanation, source: "fresh" }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 100) }, origin);
  }
}
