// =============================================================================
// COACH PANEL — Interactive chat. Right-docked on desktop, FAB + slide-over
// on mobile. Hidden entirely on public routes (landing/login/register) so it
// never overlays the signup CTAs on phones.
// =============================================================================

import { getState, subscribe, setSetting } from "../state.js";
import { getInstrument } from "../data/universe.js";
import { getNews } from "../data/news.js";
import { formatRupees, formatPct } from "../money.js";
import { SYSTEM_PROMPT, matchTemplate, isOffTopic, offTopicRedirect, STARTER_QUESTIONS } from "../coach/persona.js";
import { runAgent } from "../coach/agent.js";

const CHAT_LOG_KEY = "ss.coachchat.v1";

let chatHistory = loadChat();
let pending = false;
let newsSnap = [];
let root;
let fab;

// Routes where the coach panel + FAB are completely hidden
const COACH_HIDDEN_ROUTES = new Set(["", "/", "/login", "/register"]);

function isCoachAllowed() {
  const state = getState();
  if (!state.isAuthed) return false;
  const hash = (location.hash.slice(1) || "/").split("?")[0];
  if (COACH_HIDDEN_ROUTES.has(hash)) return false;
  return true;
}

const SAATHI_SYSTEM = `${SYSTEM_PROMPT}\n\n# TOOL USE\nYou have tools for live data: get_stock_price, get_crypto_price, search_stocks, get_market_news, get_user_portfolio. USE them whenever the user asks about any specific stock, crypto, market state, or their portfolio. Never guess numbers — always call the tool.`;

function loadChat() {
  try { const raw = localStorage.getItem(CHAT_LOG_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}
function saveChat() {
  // Cap to the last 80 messages. On QuotaExceededError, progressively halve
  // until the write succeeds — losing old chat history is better than
  // silently failing to persist new messages.
  let keep = 80;
  while (keep >= 10) {
    try {
      localStorage.setItem(CHAT_LOG_KEY, JSON.stringify(chatHistory.slice(-keep)));
      return;
    } catch (e) {
      const isQuota = e && (e.name === "QuotaExceededError"
                            || (e.code && (e.code === 22 || e.code === 1014)));
      if (!isQuota) return;
      keep = Math.floor(keep / 2);
    }
  }
  // Last resort: drop everything
  try { localStorage.removeItem(CHAT_LOG_KEY); } catch {}
}

function smartTemplateReply(userText, state) {
  return matchTemplate(userText, {
    holdings: state.holdings || {},
    newsItems: newsSnap,
    symbolOf: getInstrument,
  });
}

function summarisePortfolio(state) {
  if (!state?.holdings) return "Not logged in.";
  const syms = Object.keys(state.holdings);
  if (!syms.length) return `Cash: ${formatRupees(state.portfolio.cashPaise, { compact: true })}. No holdings yet.`;
  const lines = syms.slice(0, 8).map(s => {
    const h = state.holdings[s];
    return `${s} × ${h.qty} @ avg ₹${(h.avgCostPaise / 100).toFixed(2)}`;
  });
  return `Cash: ${formatRupees(state.portfolio.cashPaise, { compact: true })}\nHoldings (${syms.length}): ${lines.join(", ")}`;
}

async function callClaudeAgent(apiKey, history, state) {
  const lastUser = [...history].reverse().find(m => m.role === "user")?.text || "";
  if (isOffTopic(lastUser)) return offTopicRedirect(lastUser);

  const portfolioSummary = summarisePortfolio(state);
  const newsContext = newsSnap.slice(0, 5).map(n => `- ${n.headline} (${n.source}) [${n.sentiment}]`).join("\n");
  const system = `${SAATHI_SYSTEM}\n\n# RUNTIME CONTEXT\n## User portfolio\n${portfolioSummary}\n\n## Latest market headlines\n${newsContext || "(none loaded)"}`;

  const messages = history.slice(-12).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));
  return await runAgent({ apiKey, system, messages });
}

// -----------------------------------------------------------------------------
export function mountCoachPanel() {
  root = document.getElementById("coach-root");
  if (!root) return;

  // Pre-fetch news (best-effort) for chat context
  getNews({ limit: 12 }).then(items => { newsSnap = items || []; render(); }).catch(() => {});

  render();
  subscribe(render);
  window.addEventListener("hashchange", render);

  // FAB — only present when the coach is allowed on this route
  fab = document.createElement("button");
  fab.className = "coach-fab";
  fab.setAttribute("aria-label", "Open coach");
  fab.innerHTML = `<span>💬</span>`;
  fab.addEventListener("click", () => {
    setSetting("coachPanelOpen", !getState().settings.coachPanelOpen);
  });
  document.body.appendChild(fab);

  const applyVisibility = () => {
    const allowed = isCoachAllowed();
    const state = getState();
    fab.style.display = allowed ? "" : "none";
    if (!allowed) {
      document.body.classList.remove("coach-docked");
      root.classList.remove("open");
      root.style.display = "none";
      return;
    }
    root.style.display = "";
    if (window.innerWidth >= 1280 && state.settings.coachPanelOpen) {
      document.body.classList.add("coach-docked");
    } else {
      document.body.classList.remove("coach-docked");
      root.classList.toggle("open", state.settings.coachPanelOpen);
    }
  };
  applyVisibility();
  window.addEventListener("resize", applyVisibility);
  window.addEventListener("hashchange", applyVisibility);
  subscribe(applyVisibility);
}

function render() {
  if (!root) return;
  const state = getState();
  const messages = renderMessagesHtml(state);
  const usingLLM = !!state.settings.anthropicKey;

  root.innerHTML = `
    <div class="coach-header">
      <div class="coach-header-title">
        <div class="coach-avatar-sm">SS</div>
        <div>
          <div style="font-size: var(--text-md);">Saathi</div>
          <div class="dim" style="font-size: 11px; font-weight: 400;">${usingLLM ? "Your key · finance only" : "Server LLM · finance only"}</div>
        </div>
      </div>
      <button class="btn btn-ghost btn-icon" id="coach-close-btn" aria-label="Close coach">✕</button>
    </div>

    <div class="coach-messages" id="coach-messages-scroll">
      ${messages}
    </div>

    <form class="coach-chat-input" id="coach-form" autocomplete="off">
      <input id="coach-input" placeholder="Ask about any stock, crypto, or concept…" maxlength="300" ${pending ? "disabled" : ""} />
      <button type="submit" id="coach-send" ${pending ? "disabled" : ""}>${pending ? "…" : "Send"}</button>
    </form>

    <div class="coach-footer">
      Grounded in live prices + your portfolio + real news
    </div>
  `;

  const ms = root.querySelector("#coach-messages-scroll");
  if (ms) ms.scrollTop = ms.scrollHeight;

  root.querySelector("#coach-close-btn")?.addEventListener("click", () => {
    setSetting("coachPanelOpen", false);
  });

  const form = root.querySelector("#coach-form");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = root.querySelector("#coach-input");
    const text = input.value.trim();
    if (!text || pending) return;
    input.value = "";
    chatHistory.push({ role: "user", text, ts: Date.now() });
    saveChat();
    pending = true;
    render();

    const s = getState();
    let reply = null;
    try {
      reply = await callClaudeAgent(s.settings.anthropicKey || null, chatHistory, s);
    } catch (e) { console.warn("agent:", e); }
    if (!reply) reply = smartTemplateReply(text, s);

    chatHistory.push({ role: "assistant", text: reply, ts: Date.now() });
    saveChat();
    pending = false;
    render();
  });

  root.querySelector("#coach-input")?.focus();
}

function renderMessagesHtml(state) {
  const trade = (state.coachMessages || []).slice(-5).map(m => ({
    role: "assistant", text: m.payload?.reflection || "",
    context: m.payload?.historical_context, question: m.payload?.suggested_q,
    warning: m.payload?.warning_level, citations: m.payload?.citations || [],
    symbol: m.triggerSymbol, ts: m.ts, isTrade: true,
  })).filter(m => m.text);

  const chat = chatHistory.slice(-20).map(m => ({ ...m, isTrade: false }));
  const all = [...trade, ...chat].sort((a, b) => a.ts - b.ts).slice(-25);

  if (!all.length && !pending) {
    return `
      <div class="coach-empty">
        <span class="emoji">🎓</span>
        <div class="font-semi" style="color: var(--text-strong); font-size: var(--text-md);">Hi — I'm Saathi</div>
        <div class="text-sm">I talk about one thing: money. Ask me any stock or crypto price, any concept, or a trade you're thinking about. I explain — I don't give tips.</div>
        <div class="flex-col gap-2" style="margin-top: var(--sp-3); width: 100%;">
          ${STARTER_QUESTIONS.slice(0, 4).map(q =>
            `<button type="button" class="filter-pill" data-suggest="${escapeAttr(q)}" style="text-align: left; font-size: 11px;">💬 ${escapeHtml(q)}</button>`
          ).join("")}
        </div>
      </div>
    `;
  }

  setTimeout(() => {
    root?.querySelectorAll("[data-suggest]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const input = root.querySelector("#coach-input");
        if (input) { input.value = btn.dataset.suggest; input.focus(); }
      });
    });
  }, 0);

  return all.map(m => {
    if (m.role === "user") {
      return `<div class="coach-user-msg">${escapeHtml(m.text)}</div>`;
    }
    if (m.isTrade) {
      const lvl = m.warning === "strong_caution" ? "strong-caution" : m.warning === "caution" ? "caution" : "";
      return `
        <div class="coach-message">
          <div class="coach-bubble ${lvl}">
            <div class="coach-bubble-head">
              <span>${timeAgo(m.ts)}</span>
              ${m.symbol ? `<span class="pill pill-neutral" style="font-size: 10px;">${m.symbol}</span>` : ""}
            </div>
            <div>${escapeHtml(m.text)}</div>
            ${m.context ? `<div class="coach-context">${escapeHtml(m.context)}</div>` : ""}
            ${m.question ? `<div class="coach-question">${escapeHtml(m.question)}</div>` : ""}
          </div>
        </div>
      `;
    }
    return `
      <div class="coach-message">
        <div class="coach-bubble">
          <div class="coach-bubble-head"><span>${timeAgo(m.ts)}</span></div>
          <div>${escapeHtml(m.text)}</div>
        </div>
      </div>
    `;
  }).join("") + (pending ? `
    <div class="coach-message">
      <div class="coach-bubble">
        <div class="coach-typing"><span></span><span></span><span></span></div>
      </div>
    </div>
  ` : "");
}

function timeAgo(ts) {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
