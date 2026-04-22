// =============================================================================
// KEEPALIVE — Vercel Cron endpoint that pings /api/chat every 4 minutes so
// the Edge function stays loaded. Prevents cold-start penalty (~2.4s) for
// the first real user request after an idle window.
//
// Also acts as a self-test: if /api/chat 500s on the dummy ping, that's
// something we'd want to know before a real user hits it.
// =============================================================================

export const config = { runtime: "edge" };

export default async function handler(req) {
  // Vercel Cron sends GET with Authorization: Bearer <CRON_SECRET>. The
  // secret is auto-managed by Vercel — it's pulled from the env var
  // CRON_SECRET if set. Public requests get rejected so strangers can't
  // abuse this to send free Gemini calls on the user's dime.
  const env = globalThis.process?.env || {};
  const expected = env.CRON_SECRET || "";
  const auth = req.headers.get("Authorization") || "";
  if (expected && auth !== `Bearer ${expected}`) {
    return new Response(JSON.stringify({ ok: false, error: "forbidden" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // Fire a minimal /api/chat request. Absolute URL is required from inside
  // an Edge function. VERCEL_URL is set automatically to the deployment's
  // .vercel.app domain; fall back to the live origin if that's missing.
  const origin = env.VERCEL_URL ? `https://${env.VERCEL_URL}` : "https://stocksaathi.co.in";
  const t0 = Date.now();
  let chatStatus = 0;
  let chatErr = null;
  try {
    const res = await fetch(`${origin}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://stocksaathi.co.in",
        "User-Agent": "StockSaathi-Keepalive/1.0",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "." }],
        temperature: 0,
        max_tokens: 5,
        profile: "chat",
      }),
    });
    chatStatus = res.status;
  } catch (e) {
    chatErr = (e && e.message) ? String(e.message).slice(0, 120) : "fetch_failed";
  }
  const ms = Date.now() - t0;

  return new Response(JSON.stringify({ ok: true, chatStatus, chatErr, ms, ts: Date.now() }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
