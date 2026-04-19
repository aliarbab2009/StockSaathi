// =============================================================================
// REGISTER — Create a StockSaathi account.
// Validation runs client-side; passwords are hashed via PBKDF2 before storage.
// =============================================================================

import {
  registerAccount, validateEmail, validatePassword, validateUsername,
} from "../auth/accounts.js";
import { switchUser } from "../state.js";
import { navigate } from "../router.js";

export function renderRegister(main) {
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

      // If Supabase requires email confirmation, user has NO session yet.
      // Show a clear "check your inbox" screen instead of bouncing to /login.
      if (res && res.needsConfirmation) {
        main.innerHTML = `
          <div class="auth-wrap">
            <div class="auth-card" style="text-align: center;">
              <div style="font-size: 48px; margin-bottom: var(--sp-3);">📧</div>
              <h1 style="margin-bottom: var(--sp-2);">Check your email</h1>
              <p class="sub">We sent a confirmation link to <strong>${escapeHtml(email)}</strong>. Click it to activate your account, then come back and log in.</p>
              <div class="info-msg" style="margin: var(--sp-4) 0; text-align: left;">
                <strong>Heads up:</strong> the confirmation comes from Supabase by default. To have it come from <code>accounts@stocksaathi.co.in</code> instead, configure custom SMTP in the Supabase dashboard (Authentication → Email Templates → SMTP Settings). Or disable email confirmation entirely in Authentication → Providers → Email.
              </div>
              <a href="#/login" class="btn btn-primary btn-block btn-lg">Go to login</a>
            </div>
          </div>
        `;
        return;
      }

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

  function showErr(msg) {
    errBox.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`;
  }
}

function escapeHtml(s) {
  const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML;
}
