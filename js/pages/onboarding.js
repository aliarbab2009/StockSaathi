// =============================================================================
// ONBOARDING — 4 steps: intro → profile → parent consent (real email) → style
// No seeded portfolio. User starts with ₹1L cash, clean slate.
// =============================================================================

import { getState, completeOnboarding } from "../state.js";
import { deliverConsent, generateConsentToken } from "../auth/email.js";
import { navigate } from "../router.js";
import { toast } from "../components/toast.js";

let step = 0;
let form = {
  age: 16,
  school: "",
  classCode: "",
  parentEmail: "",
  riskProfile: null,
  consentToken: null,
  consentSent: false,
  consentMode: null,    // "emailjs" | "mailto"
  mailtoHref: null,
  consentCode: "",      // user types the code the parent approved
  parentName: "",
};

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "profile", label: "Profile" },
  { id: "consent", label: "Consent" },
  { id: "style",   label: "Style" },
];

export function renderOnboarding(main) {
  step = 0;
  // Pre-fill from state if user is revisiting
  const s = getState();
  if (s.user.age) form.age = s.user.age;
  if (s.user.school) form.school = s.user.school;
  if (s.user.classCode) form.classCode = s.user.classCode;
  if (s.user.parentEmail) form.parentEmail = s.user.parentEmail;
  if (s.user.riskProfile) form.riskProfile = s.user.riskProfile;
  render(main);
}

function render(main) {
  main.innerHTML = `
    <div class="onboard-wrap">
      <div class="onboard-steps">
        ${STEPS.map((s, i) => `
          <div class="onboard-step ${i === step ? "active" : i < step ? "done" : ""}">
            <div class="dot">${i < step ? "✓" : i + 1}</div>
            <div class="label">${s.label}</div>
          </div>
        `).join("")}
      </div>

      <div class="card" style="padding: var(--sp-6);">
        ${renderStep(step)}
      </div>
    </div>
  `;

  attachStepListeners(main);
}

function renderStep(s) {
  switch (s) {
    case 0: return `
      <div style="text-align: center;">
        <div style="font-size: 48px; margin-bottom: var(--sp-3);">📈</div>
        <h2 style="font-size: var(--text-2xl); margin-bottom: var(--sp-2);">Welcome to StockSaathi</h2>
        <p class="muted" style="max-width: 400px; margin: 0 auto var(--sp-5); line-height: 1.6;">
          You'll get <strong style="color: var(--text-strong);">₹1,00,000 of virtual money</strong> to invest in real Indian stocks and mutual funds. An AI coach will reflect on every trade — never tell you what to buy.
        </p>
        <button class="btn btn-primary btn-lg" data-next>Get started →</button>
      </div>
    `;
    case 1: return `
      <h2 style="margin-bottom: var(--sp-4);">Tell us about you</h2>
      <div class="flex-col gap-4">
        <div>
          <label class="label" for="f-age">Age</label>
          <input class="input" id="f-age" type="number" min="13" max="18" value="${form.age}" />
          <div class="dim text-xs" style="margin-top: 4px;">Must be 13-18 for StockSaathi.</div>
        </div>
        <div>
          <label class="label" for="f-school">School (optional)</label>
          <input class="input" id="f-school" placeholder="e.g. DPS R.K. Puram" value="${escapeAttr(form.school)}" />
        </div>
        <div>
          <label class="label" for="f-class">Class / batch code (optional)</label>
          <input class="input" id="f-class" placeholder="e.g. 12-Science or FINED-A" value="${escapeAttr(form.classCode)}" />
          <div class="dim text-xs" style="margin-top: 4px;">Useful if your teacher has set up a class leaderboard.</div>
        </div>
      </div>
      <div class="flex gap-2 wrap justify-between" style="margin-top: var(--sp-5);">
        <button class="btn btn-outline" data-back>Back</button>
        <button class="btn btn-primary" data-next>Continue</button>
      </div>
    `;
    case 2: return `
      <h2 style="margin-bottom: var(--sp-3);">Parent consent</h2>
      <p class="muted text-md" style="margin-bottom: var(--sp-4); line-height: 1.65;">
        Because you're under 18, we need a parent or guardian's consent before you can trade.
        We'll email them a 6-digit code — ask them to share it with you, then enter it below.
      </p>
      <div class="flex-col gap-4">
        <div>
          <label class="label" for="f-pname">Parent / guardian name (optional)</label>
          <input class="input" id="f-pname" placeholder="e.g. Priya Sharma" value="${escapeAttr(form.parentName)}" />
        </div>
        <div>
          <label class="label" for="f-pmail">Parent / guardian email</label>
          <input class="input" id="f-pmail" type="email" placeholder="parent@example.com" value="${escapeAttr(form.parentEmail)}" />
        </div>
        ${!form.consentSent ? `
          <div class="flex gap-2 wrap">
            <button class="btn btn-primary" id="send-consent-btn">Send consent email</button>
          </div>
        ` : `
          <div class="${form.consentMode === 'smtp' || form.consentMode === 'resend' ? 'success-msg' : 'info-msg'}" style="display: flex; flex-direction: column; gap: 8px;">
            ${form.consentMode === 'smtp' || form.consentMode === 'resend'
              ? `<div>✅ Email sent via ${form.consentMode.toUpperCase()} to <strong>${escapeHtml(form.parentEmail)}</strong>. Ask them to read you the 6-digit code from the email.</div>`
              : `<div>⚠️ Backend dev-log mode — your email was logged to <code>app/logs/emails/</code> on the server instead of being sent. To actually deliver, configure SMTP or Resend in <code>app/.env</code> (see .env.example).</div>`
            }
            <div class="text-xs muted" style="margin-top: 6px;">Code not arrived? Check spam, or resend.</div>
          </div>

          <div>
            <label class="label" for="f-pcode">Enter the code your parent received</label>
            <input class="input" id="f-pcode" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="6-digit code from parent" value="${escapeAttr(form.consentCode)}" style="font-family: var(--font-mono); letter-spacing: 0.2em; text-align: center; font-size: var(--text-lg);" />
          </div>

          <div class="flex gap-2">
            <button class="btn btn-ghost btn-sm" id="resend-consent-btn">Resend email</button>
          </div>
        `}
      </div>
      <div class="flex gap-2 wrap justify-between" style="margin-top: var(--sp-5);">
        <button class="btn btn-outline" data-back>Back</button>
        <button class="btn btn-primary" data-next ${form.consentSent ? "" : "disabled"}>Continue</button>
      </div>
    `;
    case 3: return `
      <h2 style="margin-bottom: var(--sp-2);">What's your style?</h2>
      <p class="muted text-md" style="margin-bottom: var(--sp-5); line-height: 1.6;">
        This tunes the coach's tone. You can still buy or sell anything on StockSaathi.
      </p>

      <div class="risk-cards">
        <button type="button" class="risk-card ${form.riskProfile === "cautious" ? "selected" : ""}" data-risk="cautious">
          <div class="risk-icon">🛡</div>
          <div class="risk-title">Cautious</div>
          <div class="risk-desc">Index funds and blue-chips. Understand the basics safely.</div>
        </button>
        <button type="button" class="risk-card ${form.riskProfile === "balanced" ? "selected" : ""}" data-risk="balanced">
          <div class="risk-icon">⚖️</div>
          <div class="risk-title">Balanced</div>
          <div class="risk-desc">Large-caps plus a few growth names. Moderate volatility.</div>
        </button>
        <button type="button" class="risk-card ${form.riskProfile === "bold" ? "selected" : ""}" data-risk="bold">
          <div class="risk-icon">🚀</div>
          <div class="risk-title">Bold</div>
          <div class="risk-desc">New-age, high-beta. Bigger swings — I want to feel them.</div>
        </button>
      </div>

      <div class="flex gap-2 wrap justify-between" style="margin-top: var(--sp-5);">
        <button class="btn btn-outline" data-back>Back</button>
        <button class="btn btn-primary" data-finish ${form.riskProfile ? "" : "disabled"}>Finish onboarding →</button>
      </div>
    `;
  }
}

function attachStepListeners(main) {
  main.querySelector("[data-next]")?.addEventListener("click", () => {
    if (step === 1) {
      form.age = parseInt(main.querySelector("#f-age").value, 10);
      form.school = main.querySelector("#f-school").value.trim();
      form.classCode = main.querySelector("#f-class").value.trim();
      if (!form.age || form.age < 13 || form.age > 18) { alert("Age must be 13-18."); return; }
    }
    if (step === 2) {
      // Check consent token matches
      const code = main.querySelector("#f-pcode")?.value?.trim();
      if (!form.consentToken?.token) { alert("Please send the consent email first."); return; }
      if (code !== form.consentToken.token) {
        alert("That code doesn't match. Check with your parent or resend the email.");
        return;
      }
      form.consentCode = code;
    }
    step++;
    render(main);
  });

  main.querySelector("[data-back]")?.addEventListener("click", () => {
    step = Math.max(0, step - 1);
    render(main);
  });

  main.querySelector("#send-consent-btn")?.addEventListener("click", async () => {
    form.parentName = main.querySelector("#f-pname")?.value?.trim() || "";
    form.parentEmail = main.querySelector("#f-pmail")?.value?.trim() || "";
    if (!form.parentEmail || !form.parentEmail.includes("@")) {
      alert("Enter a valid email.");
      return;
    }
    const btn = main.querySelector("#send-consent-btn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      const state = getState();
      const token = generateConsentToken();
      const teenName = state.user.displayName || state.user.username || "your child";
      const res = await deliverConsent({ teenName, parentEmail: form.parentEmail, token: token.token });
      if (!res.ok) {
        const reason = res.reason === "backend_unreachable"
          ? "Backend not running. Launch it with run.bat (it starts the Python server that sends email)."
          : (res.reason || "send_failed");
        alert("Couldn't send consent email: " + reason);
        btn.disabled = false;
        btn.textContent = "Send consent email";
        return;
      }
      form.consentSent = true;
      form.consentToken = token;
      form.consentMode = res.mode;
      form.consentNote = res.note;
      render(main);
      if (res.mode === "smtp" || res.mode === "resend") {
        toast({ kind: "success", message: `Email sent via ${res.mode.toUpperCase()}.` });
      } else if (res.mode === "devlog") {
        toast({ kind: "warn", message: "Backend running in dev-log mode (no SMTP). See Settings." });
      }
    } catch (e) {
      alert("Couldn't send consent email: " + e.message);
      btn.disabled = false;
      btn.textContent = "Send consent email";
    }
  });

  main.querySelector("#resend-consent-btn")?.addEventListener("click", async () => {
    const state = getState();
    const teenName = state.user.displayName || state.user.username || "your child";
    const res = await deliverConsent({ teenName, parentEmail: form.parentEmail, token: form.consentToken.token });
    form.consentMode = res.mode;
    form.consentNote = res.note;
    render(main);
    toast({ kind: "info", message: res.ok ? `Email re-sent via ${res.mode}.` : "Resend failed." });
  });

  // Live-update consent code input so "Continue" can validate
  main.querySelector("#f-pcode")?.addEventListener("input", (e) => {
    form.consentCode = e.target.value.trim();
    const next = main.querySelector("[data-next]");
    if (next) next.disabled = !form.consentSent;
  });

  main.querySelectorAll("[data-risk]").forEach(btn => {
    btn.addEventListener("click", () => {
      form.riskProfile = btn.dataset.risk;
      render(main);
    });
  });

  main.querySelector("[data-finish]")?.addEventListener("click", () => {
    if (!form.riskProfile) { alert("Pick a style."); return; }
    completeOnboarding({
      age: form.age,
      school: form.school || null,
      classCode: form.classCode || null,
      riskProfile: form.riskProfile,
      parentEmail: form.parentEmail,
      parentConsentAt: Date.now(),
    });
    // NO SEED PORTFOLIO. User starts with pure ₹1L cash.
    toast({ kind: "success", message: "Welcome to StockSaathi. You have ₹1,00,000 to start." });
    navigate("/portfolio");
  });
}

function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
