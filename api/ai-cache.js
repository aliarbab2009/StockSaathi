// =============================================================================
// /api/ai-cache  —  Read/write shared AI response cache.
//
// GET  /api/ai-cache?bucket=explain&key=pe   -> { payload | null, hit }
// POST /api/ai-cache  body: { bucket, key, display, payload }  -> { ok, cached_at }
//
// Reads are public (RLS policy allows anyone to select). Writes require
// the server's SUPABASE_SERVICE_ROLE_KEY and happen only from this
// endpoint after a successful upstream generation.
//
// Every AI feature in the app can use this single cache by picking a
// unique `bucket` string:
//   bucket="explain"        -> finance-term tooltip definitions
//   bucket="news_tldr"      -> per-headline TL;DR + sentiment
//   bucket="crash_scenario" -> custom-crash generator output
//   bucket="stock_why"      -> "why is X moving today"
//   etc.
// =============================================================================

export const config = { runtime: "edge" };

const MAX_BODY = 128 * 1024;
const MAX_KEY_LEN = 400;
const MAX_BUCKET_LEN = 40;

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
    "Cache-Control": "no-store",
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
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, MAX_KEY_LEN);
}

async function supabaseFetch(path, opts = {}) {
  const e = env();
  const url = e.SUPABASE_URL;
  const key = opts.serviceRole ? e.SUPABASE_SERVICE_ROLE_KEY : e.SUPABASE_ANON_KEY;
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

export default async function handler(req) {
  const origin = req.headers.get("Origin") || "";
  if (origin && !allowed(origin)) return j(403, { error: "forbidden_origin" }, origin);

  if (req.method === "OPTIONS") {
    const h = cors(origin);
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type");
    h.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers: h });
  }

  if (req.method === "GET") {
    const { searchParams } = new URL(req.url);
    const bucket = normalize(searchParams.get("bucket"));
    const rawKey = searchParams.get("key") || "";
    const key = normalize(rawKey);
    if (!bucket || !key) return j(400, { error: "bad_params" }, origin);
    if (bucket.length > MAX_BUCKET_LEN) return j(400, { error: "bucket_too_long" }, origin);

    try {
      const path = `/rest/v1/ai_response_cache?select=payload,display_key,created_at&bucket=eq.${encodeURIComponent(bucket)}&cache_key=eq.${encodeURIComponent(key)}&limit=1`;
      const res = await supabaseFetch(path);
      if (!res.ok) return j(200, { payload: null, hit: false, degraded: true }, origin);
      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.length) return j(200, { payload: null, hit: false }, origin);
      return j(200, {
        payload: rows[0].payload,
        display: rows[0].display_key,
        hit: true,
        created_at: rows[0].created_at,
      }, origin);
    } catch (e) {
      // Cache misses silently — caller will re-generate and re-cache.
      return j(200, { payload: null, hit: false, degraded: true }, origin);
    }
  }

  if (req.method === "POST") {
    const cl = parseInt(req.headers.get("Content-Length") || "0", 10);
    if (cl > MAX_BODY) return j(413, { error: "payload_too_large" }, origin);
    let body;
    try { body = await req.json(); }
    catch { return j(400, { error: "bad_body" }, origin); }
    const bucket = normalize(body.bucket);
    const key = normalize(body.key);
    if (!bucket || !key) return j(400, { error: "bad_params" }, origin);
    if (body.payload == null) return j(400, { error: "missing_payload" }, origin);

    try {
      const path = "/rest/v1/ai_response_cache";
      const row = {
        bucket,
        cache_key: key,
        display_key: typeof body.display === "string" ? body.display.slice(0, MAX_KEY_LEN) : null,
        payload: body.payload,
      };
      const res = await supabaseFetch(path, {
        method: "POST",
        serviceRole: true,
        prefer: "resolution=merge-duplicates,return=minimal",
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return j(500, { error: "cache_write_failed", detail: txt.slice(0, 160) }, origin);
      }
      return j(200, { ok: true }, origin);
    } catch (e) {
      return j(500, { error: "cache_write_exception", detail: String(e.message).slice(0, 120) }, origin);
    }
  }

  return j(405, { error: "method_not_allowed" }, origin);
}
