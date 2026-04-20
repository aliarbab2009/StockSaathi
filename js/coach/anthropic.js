// =============================================================================
// ANTHROPIC BRIDGE — OPTIONAL. Only runs when user pastes an API key in Settings.
// Uses the browser-side Anthropic API with the `anthropic-dangerous-direct-browser-access`
// header. This is fine for a BYO-key path (teen pastes their own key locally); the
// production coach path goes through /api/chat (Groq) on the server instead.
//
// If no key is set OR the call fails, we fall back to templates silently.
// =============================================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5-20250929";  // stable alias; graceful fallback handled
const LLM_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = `You are a financial-behavior reflection companion for Indian students aged 13-18 using a virtual-money investment simulator. You are NOT a financial advisor. You NEVER recommend buying or selling. You observe patterns and ask Socratic questions.

Tone: warm, curious, direct — like a slightly older sibling who studied behavioral economics, not a bank ad. Plain English. Light Hinglish only when user has opted in.

Rules (absolute):
- Never use: "should buy", "should sell", "recommend", "target price", "guaranteed", "sure shot", "will go up", "will crash"
- Always cite evidence when making claims about history
- Keep responses under 90 words
- Be specific to the user's trade and portfolio — not generic

You will receive structured input with: detected biases (from a deterministic engine you MUST trust), trade details, and historical analogs. Your job is to verbalise what the engine flagged in a way that sounds human — NOT to decide whether a bias applies.

Output format: plain prose, 2-3 sentences, ending with ONE Socratic question. Do NOT wrap in JSON.`;

export async function callClaude(apiKey, { event, tick, biases, analog, payload }) {
  if (!apiKey || apiKey.length < 20) return null;

  const userMsg = [
    `Event: ${event.type}`,
    tick.symbol ? `Instrument: ${tick.name || tick.symbol}` : null,
    tick.qty != null ? `Quantity: ${tick.qty}` : null,
    tick.pricePaise ? `Price: ₹${(tick.pricePaise / 100).toFixed(2)}` : null,
    biases.length
      ? `Detected biases (with severity):\n${biases.map(b => `- ${b.bias}: ${(b.severity * 100).toFixed(0)}%, evidence=${JSON.stringify(b.evidence)}`).join("\n")}`
      : `No biases detected.`,
    analog
      ? `Historical analog available: ${analog.sampleSize} past dips ≥${analog.bucket}% on ${analog.instrument.name}, median recovery ${analog.recoveryDays} trading days.`
      : null,
    `Your template-layer draft (for reference — you may rephrase but keep the substance):\n"${payload.reflection}"`,
    `Suggested question: "${payload.suggested_q || ""}"`,
    ``,
    `Write the coach response (prose, 2-3 sentences + 1 question, under 90 words).`,
  ].filter(Boolean).join("\n\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 220,
        temperature: 0.35,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("Anthropic error:", res.status, txt);
      return null;
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text;
    if (!text) return null;
    return text.trim();
  } catch (e) {
    clearTimeout(timeout);
    console.warn("Anthropic fetch failed:", e);
    return null;
  }
}
