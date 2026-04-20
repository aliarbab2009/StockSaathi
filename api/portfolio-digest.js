// =============================================================================
// /api/portfolio-digest  —  One-paragraph AI commentary on a user's current
// portfolio state: value, day's move, biggest mover, concentration risk,
// cash position. Grounded in the numbers the client sends; no price
// hallucination.
//
// POST body:
//   {
//     totalRupees: number,
//     deltaPct: number (since start),
//     cashRupees: number,
//     holdings: [
//       { symbol, name, sector, qty, avgRupees, curRupees, dayPct, plPct }
//     ]  // up to 15
//   }
//
// Returns: { narrative: "...", mood: "up" | "down" | "flat" | "empty" }
//
// Not cached server-side (per-user portfolio). Client caches per-day.
// =============================================================================

export const config = { runtime: "edge" };

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

function baseUrl() {
  const v = globalThis.process?.env?.VERCEL_URL;
  return v ? `https://${v}` : "https://stocksaathi.co.in";
}

const SYSTEM = `You are Saathi — a finance coach for Indian teens. Look at the structured portfolio snapshot the user sends and write a tight one-paragraph take for them, in their voice (second person). Return strict JSON:

{
  "narrative": "<60-90 word paragraph, second person ('your portfolio…'), warm + sharp>",
  "mood": "up" | "down" | "flat" | "empty"
}

Rules:
- Quote the numbers exactly from the input. Never invent figures.
- Name the biggest mover (best and/or worst) by ticker.
- If one position is > 40% of the portfolio, flag concentration risk plainly.
- If cash > 50% of portfolio, mention it neutrally ('a lot of powder dry') — don't urge them to invest.
- No emojis. No markdown. No bullet lists. Plain prose.
- No buy/sell calls. No predictions.
- If holdings array is empty, encourage first trade with warmth (not pushy).
- Return only the JSON.`;

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

  if (typeof body.totalRupees !== "number") return j(400, { error: "bad_payload" }, origin);

  const safeHoldings = Array.isArray(body.holdings) ? body.holdings.slice(0, 15) : [];
  const payload = {
    totalRupees: body.totalRupees,
    deltaPct: Number(body.deltaPct) || 0,
    cashRupees: Number(body.cashRupees) || 0,
    holdings: safeHoldings.map(h => ({
      symbol: String(h.symbol || "").slice(0, 20),
      name: String(h.name || "").slice(0, 60),
      sector: String(h.sector || "").slice(0, 40),
      qty: Number(h.qty) || 0,
      avgRupees: Number(h.avgRupees) || 0,
      curRupees: Number(h.curRupees) || 0,
      dayPct: Number(h.dayPct) || 0,
      plPct: Number(h.plPct) || 0,
    })),
  };

  const userMsg = [
    `Total portfolio value: ₹${payload.totalRupees.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
    `Since start: ${payload.deltaPct >= 0 ? "+" : ""}${payload.deltaPct.toFixed(2)}%`,
    `Cash sitting: ₹${payload.cashRupees.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
    payload.holdings.length === 0
      ? `Holdings: none yet.`
      : `Holdings:\n${payload.holdings.map(h => `  ${h.symbol} (${h.name}, ${h.sector}) — ${h.qty} units, avg ₹${h.avgRupees.toFixed(2)}, now ₹${h.curRupees.toFixed(2)}, day ${h.dayPct >= 0 ? "+" : ""}${h.dayPct.toFixed(2)}%, P/L ${h.plPct >= 0 ? "+" : ""}${(h.plPct * 100).toFixed(2)}%`).join("\n")}`,
  ].join("\n");

  try {
    const res = await fetch(baseUrl() + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "https://stocksaathi.co.in" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userMsg },
        ],
        max_tokens: 260,
        temperature: 0.4,
        response_format: { type: "json_object" },
        profile: "reasoning",
      }),
    });
    if (!res.ok) return j(502, { error: `chat_http_${res.status}` }, origin);
    const d = await res.json();
    const text = d?.choices?.[0]?.message?.content;
    if (!text) return j(502, { error: "empty_response" }, origin);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { return j(502, { error: "non_json" }, origin); }
    const narrative = typeof parsed.narrative === "string" ? parsed.narrative.trim().slice(0, 800) : "";
    const mood = ["up", "down", "flat", "empty"].includes(parsed.mood) ? parsed.mood
      : (payload.holdings.length === 0 ? "empty" : payload.deltaPct > 1 ? "up" : payload.deltaPct < -1 ? "down" : "flat");
    if (!narrative) return j(502, { error: "no_narrative" }, origin);
    return j(200, { narrative, mood }, origin);
  } catch (e) {
    return j(502, { error: "generation_failed", detail: String(e.message).slice(0, 100) }, origin);
  }
}
