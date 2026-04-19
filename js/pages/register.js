// =============================================================================
// REGISTER — Signup + 6-digit OTP verification (no email links).
// =============================================================================

import {
  registerAccount, validateEmail, validatePassword, validateUsername,
  verifySignupOtp, resendSignupOtp,
} from "../auth/accounts.js";
import { switchUser } from "../state.js";
import { navigate } from "../router.js";

export function renderRegister(main) {
  let stage = "form";    // "form" → "otp" → done
  let pendingEmail = "";
  let pendingName = "";
  let resendCountdown = 0;
  let resendTimer = null;

  // If the user already has a session (e.g. they clicked the confirmation
  // link in a new tab + Supabase SDK picked up the URL hash + wrote the
  // session to localStorage), skip the register flow entirely.
  (async () => {
    try {
      const { sb } = await import("../db/supabase.js");
      const client = await sb();
      if (!client) return;
      const { data } = await client.auth.getSession();
      if (data?.session?.user) {
        const { refreshCurrentUser } = await import("../auth/accounts.js");
        await refreshCurrentUser();
        const { bootSync, loadAllFromDb } = await import("../db/sync.js");
        await bootSync();
        await loadAllFromDb();
        switchUser();
        navigate("/onboarding");
      }
    } catch {}
  })();

  render();

  function render() {
    if (stage === "otp") return renderOtp();
    return renderForm();
  }

  function renderForm() {
    main.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <h1>Create your StockSaathi account</h1>
          <p class="sub">Your ₹1,00,000 virtual portfolio is one minute away.</p>

          <form class="auth-form" id="reg-form" autocomplete="on">
            <div class="field">
              <label class="label" for="r-name">Your full name</label>
              <input class="input" id="r-name" name="name" type="text" required autocomplete="name" placeholder="e.g. Ananya Sharma" />
            </div>
            <div class="field">
              <label class="label" for="r-username">Username</label>
              <div class="input-prefix">
                <span class="px">@</span>
                <input id="r-username" name="username" type="text" required autocomplete="username" placeholder="yourhandle" />
              </div>
              <div class="muted text-xs" style="margin-top: 4px;">3-24 chars. Letters, numbers, underscores, dots. Friends will use this to send you money.</div>
            </div>
            <div class="field">
              <label class="label" for="r-email">Email</label>
              <input class="input" id="r-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" />
            </div>
            <div class="field">
              <label class="label" for="r-pw">Password</label>
              <input class="input" id="r-pw" name="password" type="password" required autocomplete="new-password" placeholder="At least 8 characters" minlength="8" />
              <div class="muted text-xs" style="margin-top: 4px;">At least 8 characters, with 1 letter and 1 number.</div>
            </div>

            <label class="flex items-start gap-2" style="font-size: var(--text-sm); color: var(--text-muted); line-height: 1.5; margin-top: var(--sp-2);">
              <input type="checkbox" class="checkbox" id="r-terms" required style="margin-top: 2px;" />
              <span>I understand StockSaathi uses <strong>virtual money only</strong>, provides
              behavioral reflection and not investment advice, and that nothing in this app
              constitutes SEBI-regulated recommendation.</span>
            </label>

            <div id="reg-error" role="alert"></div>
            <button type="submit" class="btn btn-primary btn-block btn-lg" id="reg-btn">Create account</button>
          </form>

          <div class="auth-switch">
            Already have an account? <a href="#/login">Log in</a>
          </div>
        </div>
      </div>
    `;

    const form = main.querySelector("#reg-form");
    const errBox = main.querySelector("#reg-error");
    const btn = main.querySelector("#reg-btn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errBox.innerHTML = "";

      const name = main.querySelector("#r-name").value.trim();
      const username = main.querySelector("#r-username").value.trim();
      const email = main.querySelector("#r-email").value.trim();
      const pw = main.querySelector("#r-pw").value;

      if (!name || name.length < 2) return showErr("Please enter your full name.");
      const uerr = validateUsername(username); if (uerr) return showErr(uerr);
      if (!validateEmail(email)) return showErr("Enter a valid email address.");
      const perr = validatePassword(pw); if (perr) return showErr(perr);

      btn.disabled = true;
      btn.textContent = "Creating account…";
      try {
        const res = await registerAccount({ username, email, password: pw, displayName: name });

        if (res && res.needsConfirmation) {
          // Switch to OTP entry
          pendingEmail = email;
          pendingName = name;
          stage = "otp";
          startResendTimer();
          render();
          return;
        }

        // Already signed in (email confirmation off)
        const { refreshCurrentUser } = await import("../auth/accounts.js");
        await refreshCurrentUser();
        const { bootSync, loadAllFromDb } = await import("../db/sync.js");
        await bootSync();
        await loadAllFromDb();
        switchUser();
        navigate("/onboarding");
      } catch (err) {
        showErr(err.message);
        btn.disabled = false;
        btn.textContent = "Create account";
      }
    });

    function showErr(msg) { errBox.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`; }
  }

  function renderOtp() {
    // Supabase's default "Confirm signup" email template contains ONLY a
    // clickable link (via {{ .ConfirmationURL }}) — no OTP code. So we show
    // the LINK flow as primary ("click the button in your email") and keep
    // the OTP input as a secondary fallback for projects that customized
    // the template to include {{ .Token }}.
    main.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div style="text-align: center; margin-bottom: var(--sp-4);">
            <div style="font-size: 48px; margin-bottom: var(--sp-2);">📬</div>
            <h1>Check your email</h1>
            <p class="sub">We sent a confirmation email to <strong>${escapeHtml(pendingEmail)}</strong>. <strong>Click the link inside</strong> to activate your account.</p>
          </div>

          <div id="otp-waiting" class="info-msg" style="display:flex;align-items:center;gap:var(--sp-2);margin-bottom:var(--sp-3);">
            <span class="spinner" aria-hidden="true"></span>
            <span>Waiting for you to click the link…</span>
          </div>

          <details class="dim text-sm" style="margin-bottom: var(--sp-3);">
            <summary style="cursor:pointer;">Got a numeric code instead?</summary>
            <form class="auth-form" id="otp-form" autocomplete="off" style="margin-top: var(--sp-3);">
              <div class="field">
                <label class="label" for="otp-input">Verification code</label>
                <input class="input" id="otp-input" type="text" inputmode="numeric" pattern="[0-9]{4,10}" maxlength="10"
                  placeholder="6-digit code"
                  style="font-family: var(--font-mono); letter-spacing: 0.25em; text-align: center; font-size: var(--text-xl); font-weight: 700;" />
                <div class="dim text-xs" style="margin-top: 6px; text-align: center;">Only for projects that customised the email template to include a token.</div>
              </div>
              <div id="otp-error" role="alert"></div>
              <button type="submit" class="btn btn-outline btn-block" id="otp-btn">Verify code</button>
            </form>
          </details>

          <div style="text-align: center; margin-top: var(--sp-3); font-size: var(--text-sm); color: var(--text-muted);">
            Didn't get it? <button type="button" class="btn-link" id="resend-btn"
              style="font-size: var(--text-sm); padding: 0;" disabled>Resend email</button>
            <span id="resend-countdown" class="dim"></span>
          </div>

          <div class="auth-switch">
            Wrong email? <a href="#" id="back-to-form">Start over</a>
          </div>
        </div>
      </div>
    `;

    const form = main.querySelector("#otp-form");
    const errBox = main.querySelector("#otp-error");
    const btn = main.querySelector("#otp-btn");
    const resendBtn = main.querySelector("#resend-btn");

    // ----- Primary path: auto-advance when Supabase establishes a session.
    // Fires when the user clicks the confirmation link (either in this tab
    // via emailRedirectTo or in another tab — the session is written to
    // localStorage key ss.sb.session.v1 and the storage event propagates).
    let authUnsub = null;
    (async () => {
      const { sb } = await import("../db/supabase.js");
      const client = await sb();
      if (!client) return;
      const { data } = client.auth.onAuthStateChange(async (event, session) => {
        if ((event === "SIGNED_IN" || event === "USER_UPDATED") && session?.user) {
          onSignedIn();
        }
      });
      authUnsub = () => data?.subscription?.unsubscribe?.();
      // Also check NOW — user may have arrived with a session already.
      const cur = await client.auth.getSession();
      if (cur.data?.session) onSignedIn();
    })();

    async function onSignedIn() {
      if (stage !== "otp") return;
      try {
        const { refreshCurrentUser } = await import("../auth/accounts.js");
        await refreshCurrentUser();
        const { bootSync, loadAllFromDb } = await import("../db/sync.js");
        await bootSync();
        await loadAllFromDb();
        switchUser();
        if (resendTimer) clearInterval(resendTimer);
        authUnsub?.();
        navigate("/onboarding");
      } catch (e) {
        console.warn("post-confirm flow failed:", e);
      }
    }

    // ----- Secondary path: user enters the numeric code manually.
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errBox.innerHTML = "";
      const code = main.querySelector("#otp-input").value.trim().replace(/\s+/g, "");
      if (!/^\d{4,10}$/.test(code)) {
        errBox.innerHTML = `<div class="error-msg">Enter the 6-digit code from your email.</div>`;
        return;
      }
      btn.disabled = true;
      btn.textContent = "Verifying…";
      try {
        await verifySignupOtp({ email: pendingEmail, code });
        await onSignedIn();
      } catch (err) {
        errBox.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
        btn.disabled = false;
        btn.textContent = "Verify code";
      }
    });

    resendBtn.addEventListener("click", async () => {
      resendBtn.disabled = true;
      try {
        await resendSignupOtp(pendingEmail);
        startResendTimer();
        const waiting = main.querySelector("#otp-waiting");
        if (waiting) waiting.innerHTML = `<span>✅ New email sent — check your inbox.</span>`;
      } catch (err) {
        errBox.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
        resendBtn.disabled = false;
      }
    });

    main.querySelector("#back-to-form").addEventListener("click", (e) => {
      e.preventDefault();
      stage = "form";
      if (resendTimer) clearInterval(resendTimer);
      authUnsub?.();
      render();
    });

    updateResendUi();
  }

  function startResendTimer() {
    resendCountdown = 60;
    if (resendTimer) clearInterval(resendTimer);
    resendTimer = setInterval(() => {
      resendCountdown--;
      if (resendCountdown <= 0) {
        clearInterval(resendTimer);
        resendTimer = null;
      }
      updateResendUi();
    }, 1000);
    updateResendUi();
  }

  function updateResendUi() {
    if (stage !== "otp") return;
    const btn = main.querySelector("#resend-btn");
    const cd = main.querySelector("#resend-countdown");
    if (!btn || !cd) return;
    if (resendCountdown > 0) {
      btn.disabled = true;
      cd.textContent = ` (${resendCountdown}s)`;
    } else {
      btn.disabled = false;
      cd.textContent = "";
    }
  }
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
