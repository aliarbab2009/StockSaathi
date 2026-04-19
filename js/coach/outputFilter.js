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
  // Regulatory tripwires even when phrased as a question — catches the
  // suggested_q smuggling path ("since TCS will rally, would you add more?").
  "will rally",
  "will tank",
  "will surge",
  "will drop",
  "will plunge",
  "will skyrocket",
  "is a buy",
  "is a sell",
  "time to buy",
  "time to sell",
  "you should add",
  "you should cut",
];

const MAX_REFLECTION_LEN = 600;
const MAX_CONTEXT_LEN = 400;
const MAX_Q_LEN = 200;

export function filterOutput(response) {
  if (!response || typeof response !== "object") {
    return { ok: false, reason: "invalid_shape" };
  }
  // Scan ALL user-facing text fields, not just reflection/context. The old
  // filter missed suggested_q, which the LLM could use to smuggle advice as
  // a Socratic question. Citation titles/notes are scanned too.
  const citationText = Array.isArray(response.citations)
    ? response.citations.map(c =>
        [c?.title, c?.note, c?.text, c?.label].filter(Boolean).join(" "))
        .join(" ")
    : "";
  const full = [
    response.reflection,
    response.historical_context,
    response.suggested_q,
    citationText,
  ].filter(Boolean).join(" ").toLowerCase();

  for (const term of BLOCKED_TERMS) {
    if (full.includes(term)) {
      return { ok: false, reason: `blocked_term: ${term}` };
    }
  }
  const out = {
    reflection: (response.reflection || "").slice(0, MAX_REFLECTION_LEN),
    historical_context: (response.historical_context || null),
    warning_level: ["info", "caution", "strong_caution"].includes(response.warning_level) ? response.warning_level : "info",
    suggested_q: response.suggested_q ? String(response.suggested_q).slice(0, MAX_Q_LEN) : null,
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
