// =============================================================================
// LOGIN — Email/username + password.
// =============================================================================

import { loginAccount } from "../auth/accounts.js";
import { switchUser } from "../state.js";
import { navigate } from "../router.js";

export function renderLogin(main) {
  // Prefill email from ?email= query param — used when register detects
  // the account already exists and redirects here so the user doesn't
  // have to retype.
  const q = (location.hash.split("?")[1] || "");
  const prefilledEmail = new URLSearchParams(q).get("email") || "";

  main.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <h1>Welcome back</h1>
        <p class="sub">Log in to continue where you left off.</p>

        <form class="auth-form" id="login-form" autocomplete="on">
          <div class="field">
            <label class="label" for="l-handle">Email or username</label>
            <input class="input" id="l-handle" name="username" type="text" required autocomplete="username" placeholder="you@example.com or yourname" value="${escapeAttr(prefilledEmail)}" />
          </div>
          <div class="field">
            <label class="label" for="l-pw" style="display:flex; justify-content:space-between; align-items:baseline;">
              <span>Password</span>
              <a href="#/reset-password-request" class="dim text-xs" style="font-weight:500;">Forgot password?</a>
            </label>
            <input class="input" id="l-pw" name="password" type="password" required autocomplete="current-password" placeholder="At least 8 characters" />
          </div>
          <div id="login-error" role="alert"></div>
          <button type="submit" class="btn btn-primary btn-block btn-lg" id="login-btn">Log in</button>
        </form>

        <div class="auth-switch">
          New to StockSaathi? <a href="#/register">Create an account</a>
        </div>
      </div>
    </div>
  `;

  // If the email was prefilled (coming from register's "already exists"
  // redirect), focus the password field so the user can type straight in.
  if (prefilledEmail) {
    queueMicrotask(() => main.querySelector("#l-pw")?.focus());
  }

  const form = main.querySelector("#login-form");
  const errBox = main.querySelector("#login-error");
  const btn = main.querySelector("#login-btn");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.innerHTML = "";
    btn.disabled = true;
    btn.textContent = "Logging in…";
    try {
      const handle = main.querySelector("#l-handle").value;
      const pw = main.querySelector("#l-pw").value;
      await loginAccount({ emailOrUsername: handle, password: pw });
      // Refresh Supabase user cache, then trigger store reload
      const { refreshCurrentUser } = await import("../auth/accounts.js");
      await refreshCurrentUser();
      const { bootSync, loadAllFromDb } = await import("../db/sync.js");
      await bootSync();
      await loadAllFromDb();
      switchUser();
      const state = (await import("../state.js")).getState();
      if (!state.user.onboarded) navigate("/onboarding");
      else navigate("/portfolio");
    } catch (err) {
      errBox.innerHTML = `<div class="error-msg">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = "Log in";
    }
  });
}

function escapeHtml(s) {
  const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML;
}
function escapeAttr(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
