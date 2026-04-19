// =============================================================================
// SETTINGS — Theme, API keys, EmailJS config, account management, reset.
// =============================================================================

import { getState, subscribe, setSetting, setSettings, resetCurrentPortfolio, switchUser } from "../state.js";
import { logoutAccount, deleteCurrentAccount, updateProfile, changePassword, currentUser } from "../auth/accounts.js";
import { navigate } from "../router.js";
import { toast } from "../components/toast.js";

export function renderSettings(main) {
  render();
  const unsub = subscribe(render);
  window.addEventListener("hashchange", () => unsub?.(), { once: true });

  function render() {
    const state = getState();
    const user = currentUser();
    main.innerHTML = `
      <div style="max-width: 760px; margin: 0 auto;">
        <h1>Settings</h1>
        <p class="muted" style="margin: var(--sp-2) 0 var(--sp-5);">Control how StockSaathi looks, what data it uses, and your account.</p>

        <div class="card">
          <h3 style="margin-bottom: var(--sp-4);">Account</h3>
          ${user ? renderAccountSection(user, state) : `<p class="muted">Not logged in.</p>`}
        </div>

        <div class="card" style="margin-top: var(--sp-4);">
          <h3 style="margin-bottom: var(--sp-4);">Appearance</h3>
          <div class="settings-row">
            <div class="label-wrap"><div class="title">Theme</div><div class="desc">Light for readability, dark for late-night sessions.</div></div>
            <div class="flex gap-2">
              <button class="btn btn-ghost btn-sm ${state.settings.theme === "light" ? "btn-primary" : ""}" data-theme="light">Light</button>
              <button class="btn btn-ghost btn-sm ${state.settings.theme === "dark" ? "btn-primary" : ""}" data-theme="dark">Dark</button>
            </div>
          </div>
          <div class="settings-row">
            <div class="label-wrap"><div class="title">Coach panel docked</div><div class="desc">Persistent right rail on wide screens, FAB on mobile.</div></div>
            <label class="switch"><input type="checkbox" id="toggle-coach" ${state.settings.coachPanelOpen ? "checked" : ""} /><span class="slider"></span></label>
          </div>
          <div class="settings-row">
            <div class="label-wrap"><div class="title">Hinglish mode</div><div class="desc">Light Hinglish turns-of-phrase in coach responses.</div></div>
            <label class="switch"><input type="checkbox" id="toggle-hinglish" ${state.settings.hinglish ? "checked" : ""} /><span class="slider"></span></label>
          </div>
        </div>

        <div class="card" style="margin-top: var(--sp-4);">
          <h3 style="margin-bottom: var(--sp-3);">Real-time data</h3>
          <p class="muted text-sm" style="margin-bottom: var(--sp-3);">
            Yahoo Finance is used by default (no key). Add a <a href="https://finnhub.io/dashboard" target="_blank" rel="noopener">Finnhub API key</a> for premium fallback on rate-limit hits. Keys live in localStorage only.
          </p>
          <div class="field">
            <label class="label" for="finnhub-key">Finnhub API key</label>
            <input class="input" id="finnhub-key" type="password" placeholder="e.g. cnxxxxx" value="${escapeAttr(state.settings.finnhubKey || "")}" />
          </div>
        </div>

        <div class="card" style="margin-top: var(--sp-4);">
          <h3 style="margin-bottom: var(--sp-3);">Coach LLM (optional)</h3>
          <p class="muted text-sm" style="margin-bottom: var(--sp-3);">
            By default the coach uses deterministic templates — which works offline and never hallucinates. If you paste an Anthropic API key, coach responses are augmented by Claude Sonnet. Keys are stored locally and never leave your browser except to call Anthropic directly.
          </p>
          <div class="field">
            <label class="label" for="anthro-key">Anthropic API key</label>
            <input class="input" id="anthro-key" type="password" placeholder="sk-ant-..." value="${escapeAttr(state.settings.anthropicKey || "")}" />
          </div>
        </div>

        <div class="card" style="margin-top: var(--sp-4);">
          <h3 style="margin-bottom: var(--sp-3);">Parent-consent email (EmailJS)</h3>
          <p class="muted text-sm" style="margin-bottom: var(--sp-3);">
            StockSaathi can send the consent email via <a href="https://www.emailjs.com/" target="_blank" rel="noopener">EmailJS</a> (free tier: 200 emails/mo). Without these, onboarding falls back to opening the user's email client with a pre-filled message.
          </p>
          <div class="flex-col gap-3">
            <div class="field">
              <label class="label" for="ejs-service">Service ID</label>
              <input class="input" id="ejs-service" placeholder="service_xxxxxx" value="${escapeAttr(state.settings.emailjs?.serviceId || "")}" />
            </div>
            <div class="field">
              <label class="label" for="ejs-template">Template ID</label>
              <input class="input" id="ejs-template" placeholder="template_xxxxxx" value="${escapeAttr(state.settings.emailjs?.templateId || "")}" />
            </div>
            <div class="field">
              <label class="label" for="ejs-public">Public key</label>
              <input class="input" id="ejs-public" type="password" placeholder="e.g. rxxxxxxx" value="${escapeAttr(state.settings.emailjs?.publicKey || "")}" />
            </div>
            <p class="dim text-xs">Template variables expected: {{to_email}}, {{teen_name}}, {{consent_code}}, {{consent_url}}, {{message}}.</p>
          </div>
        </div>

        <div class="card" style="margin-top: var(--sp-4);">
          <h3 style="margin-bottom: var(--sp-3);">Danger zone</h3>
          <div class="settings-row">
            <div class="label-wrap"><div class="title">Reset portfolio</div><div class="desc">Clear your trades, cash, coach history, transfers. You keep your account and friends.</div></div>
            <button class="btn btn-outline" id="reset-pf-btn" style="color: var(--warning); border-color: var(--warning);">Reset portfolio</button>
          </div>
          <div class="settings-row">
            <div class="label-wrap"><div class="title">Delete account</div><div class="desc">Permanently delete your StockSaathi account. Cannot be undone.</div></div>
            <button class="btn btn-danger" id="delete-account-btn">Delete account</button>
          </div>
        </div>

        <div class="card" style="margin-top: var(--sp-4); background: var(--bg-soft);">
          <h3 style="margin-bottom: var(--sp-3);">About</h3>
          <p class="text-sm" style="line-height: 1.7;"><strong>StockSaathi</strong> is a proof-of-concept for the Masters' Union AI Buildathon 2026, problem statement F6.</p>
          <p class="muted text-sm" style="line-height: 1.7; margin-top: var(--sp-2);">Stack: vanilla ES modules, custom SVG charts, client-side state with localStorage persistence, Web Crypto password hashing (PBKDF2), optional Claude LLM + EmailJS + Finnhub. Zero build step. Works fully offline after first load.</p>
          <p class="dim text-xs" style="line-height: 1.7; margin-top: var(--sp-2);">Not affiliated with SEBI, NSE, BSE, or any broker. All prices are delayed; they come from Yahoo Finance or a synthetic fallback. No advice is ever provided; this product is behavioral reflection, not investment advice.</p>
        </div>
      </div>
    `;

    // Theme
    main.querySelector("[data-theme='light']").addEventListener("click", () => { document.documentElement.setAttribute("data-theme", "light"); setSetting("theme", "light"); });
    main.querySelector("[data-theme='dark']").addEventListener("click", () => { document.documentElement.setAttribute("data-theme", "dark"); setSetting("theme", "dark"); });
    main.querySelector("#toggle-coach").addEventListener("change", (e) => setSetting("coachPanelOpen", e.target.checked));
    main.querySelector("#toggle-hinglish").addEventListener("change", (e) => setSetting("hinglish", e.target.checked));

    main.querySelector("#finnhub-key").addEventListener("change", (e) => { setSetting("finnhubKey", e.target.value.trim()); toast({ kind: "success", message: "Finnhub key saved." }); });
    main.querySelector("#anthro-key").addEventListener("change", (e) => { setSetting("anthropicKey", e.target.value.trim()); toast({ kind: "success", message: "Anthropic key saved." }); });

    const saveEJS = () => {
      setSettings({
        emailjs: {
          serviceId: main.querySelector("#ejs-service").value.trim(),
          templateId: main.querySelector("#ejs-template").value.trim(),
          publicKey: main.querySelector("#ejs-public").value.trim(),
        },
      });
    };
    main.querySelector("#ejs-service").addEventListener("change", saveEJS);
    main.querySelector("#ejs-template").addEventListener("change", saveEJS);
    main.querySelector("#ejs-public").addEventListener("change", () => { saveEJS(); toast({ kind: "success", message: "EmailJS config saved." }); });

    main.querySelector("#reset-pf-btn").addEventListener("click", () => {
      if (confirm("Reset your portfolio, trades, coach messages, and transfers? Your account stays.")) {
        resetCurrentPortfolio();
        toast({ kind: "success", message: "Portfolio reset." });
      }
    });
    main.querySelector("#delete-account-btn").addEventListener("click", () => {
      if (confirm("This will permanently delete your StockSaathi account. Are you sure?")) {
        deleteCurrentAccount();
        switchUser();
        navigate("/");
      }
    });

    // Profile section handlers
    main.querySelector("#profile-save")?.addEventListener("click", async () => {
      const displayName = main.querySelector("#profile-name").value.trim();
      const school = main.querySelector("#profile-school").value.trim();
      try {
        updateProfile({ displayName, school });
        toast({ kind: "success", message: "Profile saved." });
      } catch (e) {
        toast({ kind: "error", message: e.message });
      }
    });

    main.querySelector("#logout-btn2")?.addEventListener("click", () => {
      logoutAccount();
      switchUser();
      navigate("/");
    });

    main.querySelector("#change-pw-btn")?.addEventListener("click", async () => {
      const cur = main.querySelector("#pw-cur").value;
      const nxt = main.querySelector("#pw-new").value;
      const msg = main.querySelector("#pw-msg");
      if (!cur || !nxt) { msg.innerHTML = `<div class="error-msg">Fill both fields.</div>`; return; }
      if (nxt.length < 8) { msg.innerHTML = `<div class="error-msg">New password must be at least 8 characters.</div>`; return; }
      try {
        await changePassword({ currentPassword: cur, newPassword: nxt });
        main.querySelector("#pw-cur").value = "";
        main.querySelector("#pw-new").value = "";
        msg.innerHTML = `<div class="success-msg">Password changed.</div>`;
      } catch (e) { msg.innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`; }
    });
  }
}

function renderAccountSection(user, state) {
  return `
    <div class="flex items-center gap-4 wrap" style="margin-bottom: var(--sp-4);">
      <div class="friend-avatar ${user.avatarColor || "green"}" style="width: 56px; height: 56px; font-size: 18px;">
        ${initials(user.displayName || user.username)}
      </div>
      <div class="grow">
        <div class="font-semi" style="font-size: var(--text-lg); color: var(--text-strong);">${escapeHtml(user.displayName || "")}</div>
        <div class="dim text-xs">@${escapeHtml(user.username)} · ${escapeHtml(user.email)}</div>
      </div>
      <button class="btn btn-ghost btn-sm" id="logout-btn2">Log out</button>
    </div>

    <div class="flex-col gap-3" style="margin-top: var(--sp-4);">
      <div class="field">
        <label class="label" for="profile-name">Display name</label>
        <input class="input" id="profile-name" value="${escapeAttr(user.displayName || "")}" />
      </div>
      <div class="field">
        <label class="label" for="profile-school">School (optional)</label>
        <input class="input" id="profile-school" value="${escapeAttr(state.user.school || "")}" />
      </div>
      <div><button class="btn btn-primary" id="profile-save">Save profile</button></div>
    </div>

    <hr />

    <h4 class="text-md font-semi" style="margin: var(--sp-3) 0 var(--sp-2);">Change password</h4>
    <div class="flex-col gap-3" style="max-width: 420px;">
      <div class="field">
        <label class="label" for="pw-cur">Current password</label>
        <input class="input" id="pw-cur" type="password" autocomplete="current-password" />
      </div>
      <div class="field">
        <label class="label" for="pw-new">New password</label>
        <input class="input" id="pw-new" type="password" autocomplete="new-password" />
      </div>
      <div><button class="btn btn-ghost" id="change-pw-btn">Update password</button></div>
      <div id="pw-msg"></div>
    </div>
  `;
}

function initials(n) {
  if (!n) return "SS";
  const p = String(n).trim().split(/\s+/);
  return (p[0][0] + (p[1]?.[0] || "")).toUpperCase();
}
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
