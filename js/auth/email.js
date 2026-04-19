// =============================================================================
// EMAIL — Parent consent delivery via the Python backend.
// No mailto. No browser email client. Real SMTP (or Resend) — or dev-log
// fallback with a clear message.
// =============================================================================

export function generateConsentToken() {
  const now = Date.now();
  return {
    token: String(Math.floor(100000 + Math.random() * 900000)),
    issuedAt: now,
    expiresAt: now + 7 * 24 * 3600 * 1000,
  };
}

/**
 * Send the consent email via the Python backend.
 * Returns { ok, mode: "smtp"|"resend"|"devlog"|"error", note?, error? }.
 */
export async function deliverConsent({ teenName, parentEmail, token }) {
  const consentUrl = `${location.origin}${location.pathname}#/onboarding?consent=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 25_000);

  try {
    const res = await fetch("/api/send-consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: parentEmail,
        teenName,
        token,
        consentUrl,
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        mode: "error",
        reason: data.reason || `http_${res.status}`,
        error: data.error || null,
      };
    }
    return {
      ok: true,
      mode: data.provider || "unknown",
      note: data.warning || null,
      loggedTo: data.logged_to || null,
    };
  } catch (e) {
    clearTimeout(t);
    return {
      ok: false,
      mode: "error",
      reason: "backend_unreachable",
      error: e?.message || String(e),
    };
  }
}

/**
 * Lightweight health probe — is the backend alive + which providers are configured?
 */
export async function probeBackend() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (!res.ok) return { alive: false };
    const data = await res.json();
    return { alive: true, providers: data.providers || {} };
  } catch {
    return { alive: false };
  }
}
