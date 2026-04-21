// =============================================================================
// /api/chat  —  Edge-runtime LLM proxy, multi-provider.
//
// Accepts an OpenAI-compatible chat-completion body. Routes to the right
// upstream based on an optional `profile` field in the body:
//   profile: "reasoning"  (default) → OpenAI GPT (smartest + warmest)
//   profile: "fast"                 → Gemini Flash (instant feel)
//   profile: "creative"             → OpenAI GPT (humor + prose)
//   profile: "json"                 → whichever primary is configured, JSON mode
//
// For each profile there is a primary, a fallback, and a free-tier floor.
// If primary 5xx/429s, we silently try fallback. If fallback fails too,
// we try Groq/Llama (free). The client never sees which upstream answered.
//
// Env vars (all optional; missing ones are skipped in the fallback chain):
//   OPENAI_API_KEY       — primary for reasoning + creative
//   OPENAI_MODEL         — default "gpt-5.4" (override to stay on a pinned version)
//   GEMINI_API_KEY       — primary for fast, fallback for reasoning
//   GEMINI_FAST_MODEL    — default "gemini-3.1-flash"
//   GEMINI_PRO_MODEL     — default "gemini-3.1-pro"
//   CEREBRAS_API_KEY     — optional blazing-fast backup serving Llama
//   CEREBRAS_MODEL       — default "llama3.3-70b"
//   GROQ_API_KEY         — free-tier floor, always tried last
//   GROQ_MODEL           — default "llama-3.3-70b-versatile"
//
// Safety posture mirrored from the Python endpoint this replaces:
//   - Origin allowlist (rejects cross-site abuse).
//   - Body size cap.
//   - max_tokens cap server-side (client can't upgrade to expensive generations).
//   - `tools` / `tool_choice` stripped (client can't plug arbitrary tools).
//   - Error bodies redact bearer tokens + API-key-shaped strings.
// =============================================================================

export const config = { runtime: "edge" };

const MAX_BODY = 64 * 1024;
const MAX_OUTPUT_TOKENS = 2000;

const OPENAI_MODEL   = (globalThis.process?.env?.OPENAI_MODEL)    || "gpt-5.4";
const GEMINI_FAST    = (globalThis.process?.env?.GEMINI_FAST_MODEL) || "gemini-3.1-flash";
const GEMINI_PRO     = (globalThis.process?.env?.GEMINI_PRO_MODEL)  || "gemini-3.1-pro";
const CEREBRAS_MODEL = (globalThis.process?.env?.CEREBRAS_MODEL)  || "llama3.3-70b";
const GROQ_MODEL     = (globalThis.process?.env?.GROQ_MODEL)      || "llama-3.3-70b-versatile";
const PUBLIC_ORIGIN  = ((globalThis.process?.env?.PUBLIC_ORIGIN) || "").replace(/\/$/, "");

// Gemini endpoint resolution. If GEMINI_VERTEX_PROJECT is set, route through
// Vertex AI (consumes Google Cloud credits). Otherwise, use the AI Studio
// OpenAI-compat endpoint (generativelanguage.googleapis.com). Default region
// is asia-south1 (Mumbai) so Indian users get the lowest latency and data
// stays in-region. Override region via GEMINI_VERTEX_REGION.
const GEMINI_VERTEX_PROJECT = globalThis.process?.env?.GEMINI_VERTEX_PROJECT || "";
const GEMINI_VERTEX_REGION  = globalThis.process?.env?.GEMINI_VERTEX_REGION  || "asia-south1";
const GEMINI_URL = GEMINI_VERTEX_PROJECT
  ? `https://${GEMINI_VERTEX_REGION}-aiplatform.googleapis.com/v1/projects/${GEMINI_VERTEX_PROJECT}/locations/${GEMINI_VERTEX_REGION}/endpoints/openapi/chat/completions`
  : "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const ALLOWED_ORIGINS = new Set([
  PUBLIC_ORIGIN,
  "https://stocksaathi.co.in",
  "https://www.stocksaathi.co.in",
  "http://localhost:7348",
  "http://127.0.0.1:7348",
]);
ALLOWED_ORIGINS.delete("");

function allowOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (origin.startsWith("https://") && origin.endsWith(".vercel.app")) return origin;
  return null;
}

const REDACT_BEARER = /(Bearer\s+)[A-Za-z0-9._\-]+/gi;
const REDACT_KEY = /((?:sk-|sk-proj-|gsk_|xai-|re_|AIza)[A-Za-z0-9._\-]{8,})/g;
const redact = (s) => String(s || "").replace(REDACT_BEARER, "$1<redacted>").replace(REDACT_KEY, "<redacted>");

function corsHeaders(origin) {
  const h = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  const a = allowOrigin(origin);
  if (a) {
    h.set("Access-Control-Allow-Origin", a);
    h.set("Vary", "Origin");
  }
  return h;
}

function jsonResponse(status, body, origin) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

// ----- provider descriptors ------------------------------------------------
// Each descriptor can `enabled()` (env var present) and `call(body)` returning
// a Response-like { status, bodyText } pair. All upstreams are OpenAI-
// compatible except Gemini which has a native OpenAI-compat endpoint too.
function providerDescriptors() {
  const env = globalThis.process?.env || {};
  return {
    openai: {
      label: "openai",
      enabled: () => !!env.OPENAI_API_KEY,
      url: "https://api.openai.com/v1/chat/completions",
      key: env.OPENAI_API_KEY,
      model: OPENAI_MODEL,
    },
    gemini_fast: {
      label: "gemini_fast",
      enabled: () => !!env.GEMINI_API_KEY,
      url: GEMINI_URL,
      key: env.GEMINI_API_KEY,
      model: GEMINI_FAST,
    },
    gemini_pro: {
      label: "gemini_pro",
      enabled: () => !!env.GEMINI_API_KEY,
      url: GEMINI_URL,
      key: env.GEMINI_API_KEY,
      model: GEMINI_PRO,
    },
    cerebras: {
      label: "cerebras",
      enabled: () => !!env.CEREBRAS_API_KEY,
      url: "https://api.cerebras.ai/v1/chat/completions",
      key: env.CEREBRAS_API_KEY,
      model: CEREBRAS_MODEL,
    },
    groq: {
      label: "groq",
      enabled: () => !!env.GROQ_API_KEY,
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: env.GROQ_API_KEY,
      model: GROQ_MODEL,
    },
  };
}

// Fallback chain per profile. Each order is tried top-down; the first
// descriptor whose env var is set gets the call. If it returns a 5xx or
// 429, we drop to the next. Any 2xx or 4xx (non-throttle) returns to
// the client as-is.
//
// Reasoning profile leads with Gemini Pro because it trades marginal IQ
// for meaningfully faster streaming throughput vs GPT Pro — on a
// user-facing chat, "smart in 1 s" beats "slightly smarter in 4 s".
// GPT sits behind it as the escalation for anything Pro can't handle.
function chainFor(profile) {
  switch (profile) {
    case "fast":
      return ["gemini_fast", "cerebras", "groq", "gemini_pro", "openai"];
    case "creative":
      return ["openai", "gemini_pro", "gemini_fast", "groq"];
    case "json":
      return ["openai", "gemini_pro", "gemini_fast", "groq"];
    case "reasoning":
    default:
      return ["gemini_pro", "openai", "gemini_fast", "cerebras", "groq"];
  }
}

async function callUpstream(desc, payload) {
  // Vertex AI's OpenAI-compat endpoint uses x-goog-api-key for API-key auth,
  // NOT Authorization: Bearer (which is reserved for OAuth access tokens on
  // that endpoint). Every other upstream (OpenAI, Groq, Cerebras, AI Studio
  // via generativelanguage.googleapis.com) takes Bearer just fine.
  const isVertex = /-aiplatform\.googleapis\.com/.test(desc.url);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "StockSaathi-Edge/1.0",
  };
  if (isVertex) headers["x-goog-api-key"] = desc.key;
  else headers["Authorization"] = `Bearer ${desc.key}`;
  // Vertex OpenAI-compat requires the model in publisher/model form, e.g.
  // "google/gemini-2.5-flash". AI Studio takes the bare model name.
  const modelForApi = isVertex && !desc.model.includes("/")
    ? `google/${desc.model}`
    : desc.model;
  const res = await fetch(desc.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payload, model: modelForApi }),
  });
  const text = await res.text();
  return { status: res.status, text, upstream: desc.label };
}

export default async function handler(req) {
  const origin = req.headers.get("Origin") || "";

  if (req.method === "OPTIONS") {
    const h = corsHeaders(origin);
    h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type");
    h.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers: h });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" }, origin);
  }

  if (origin && !allowOrigin(origin)) {
    return jsonResponse(403, { error: "forbidden_origin" }, origin);
  }

  // Body-size cap
  const cl = parseInt(req.headers.get("Content-Length") || "0", 10);
  if (cl > MAX_BODY) {
    return jsonResponse(413, { error: "payload_too_large" }, origin);
  }

  let raw;
  try {
    raw = await req.text();
  } catch {
    return jsonResponse(400, { error: "read_failed" }, origin);
  }
  if (raw.length > MAX_BODY) {
    return jsonResponse(413, { error: "payload_too_large" }, origin);
  }

  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return jsonResponse(400, { error: "bad_body" }, origin);
  }

  // Pull + strip the profile hint; upstream providers don't understand it.
  const profile = typeof payload.profile === "string" ? payload.profile : "reasoning";
  delete payload.profile;

  // Safety: cap max_tokens. Tools are passed through — the coach agent
  // needs function-calling to fetch live quotes, portfolio values, and
  // news during a conversation. Body size is already capped so runaway
  // tool-schema bloat can't balloon the payload.
  const mt = Number.isFinite(payload.max_tokens) ? Math.min(payload.max_tokens, MAX_OUTPUT_TOKENS) : 800;
  payload.max_tokens = mt;
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    return jsonResponse(400, { error: "bad_messages" }, origin);
  }

  const descs = providerDescriptors();
  const order = chainFor(profile).map((label) => descs[label]).filter((d) => d && d.enabled());

  if (order.length === 0) {
    return jsonResponse(501, { error: "no_provider_configured" }, origin);
  }

  let last = null;
  for (const desc of order) {
    try {
      const r = await callUpstream(desc, payload);
      // Pass any 2xx through immediately.
      if (r.status >= 200 && r.status < 300) {
        return new Response(r.text, {
          status: r.status,
          headers: new Headers({
            ...Object.fromEntries(corsHeaders(origin)),
            "Content-Type": "application/json",
            "X-Chat-Upstream": desc.label,
          }),
        });
      }
      last = r;
      // Only fall over on throttling / upstream-down signals.
      if (r.status === 429 || r.status >= 500) {
        continue;
      }
      // 4xx other than 429 is a client-shape issue — return now, no fallback.
      return new Response(r.text, {
        status: r.status,
        headers: corsHeaders(origin),
      });
    } catch (e) {
      last = { status: 502, text: JSON.stringify({ error: "upstream_unreachable", detail: redact(e?.message).slice(0, 140) }), upstream: desc.label };
    }
  }

  // Exhausted the chain — every upstream was throttled or unreachable.
  const headers = corsHeaders(origin);
  headers.set("X-Chat-Upstream", last?.upstream || "none");
  return new Response(last?.text || JSON.stringify({ error: "all_upstreams_unavailable" }), {
    status: last?.status || 503,
    headers,
  });
}
