// =============================================================================
// OUTPUT FILTER — Last line of defense before coach output reaches the user.
// Blocks SEBI-actionable language in proximity to ticker names.
// Also validates the response schema and truncates to length cap.
// =============================================================================

const BLOCKED_TERMS = [
  "should buy",
  "should sell",
  "recommend",
  "target price",
  "guaranteed",
  "sure shot",
  "surefire",
  "definitely buy",
  "definitely sell",
  "will go up",
  "will go down",
  "will crash",
  "will moon",
  "can't lose",
  "no risk",
  "risk-free",
];

const MAX_REFLECTION_LEN = 600;
const MAX_CONTEXT_LEN = 400;

export function filterOutput(response) {
  if (!response || typeof response !== "object") {
    return { ok: false, reason: "invalid_shape" };
  }
  const text = [response.reflection, response.historical_context].filter(Boolean).join(" ").toLowerCase();
  for (const term of BLOCKED_TERMS) {
    if (text.includes(term)) {
      return { ok: false, reason: `blocked_term: ${term}` };
    }
  }
  const out = {
    reflection: (response.reflection || "").slice(0, MAX_REFLECTION_LEN),
    historical_context: (response.historical_context || null),
    warning_level: ["info", "caution", "strong_caution"].includes(response.warning_level) ? response.warning_level : "info",
    suggested_q: response.suggested_q || null,
    citations: Array.isArray(response.citations) ? response.citations.slice(0, 6) : [],
  };
  if (out.historical_context && out.historical_context.length > MAX_CONTEXT_LEN) {
    out.historical_context = out.historical_context.slice(0, MAX_CONTEXT_LEN);
  }
  return { ok: true, payload: out };
}

const SAFE_FALLBACK = {
  reflection: "Noted. The coach is taking a short break — but your trade was logged and your portfolio updated.",
  historical_context: null,
  warning_level: "info",
  suggested_q: null,
  citations: [],
};

export function safeFallback() {
  return { ...SAFE_FALLBACK };
}
