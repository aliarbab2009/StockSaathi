// =============================================================================
// COACH PANEL — Interactive chat + coach reflections. Right-docked on desktop.
// Uses Claude (if API key in settings) or a smart template matcher grounded in
// the user's actual portfolio and latest news.
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
let newsSnap = [];   // latest news cache

function loadChat() {
  try { const raw = localStorage.getItem(CHAT_LOG_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}
function saveChat() {
  try { localStorage.setItem(CHAT_LOG_KEY, JSON.stringify(chatHistory.slice(-80))); } catch {}
}

function smartTemplateReply(userText, state) {
  return matchTemplate(userText, {
    holdings: state.holdings || {},
    newsItems: newsSnap,
    symbolOf: getInstrument,
  });
}

async function callClaudeAgent(apiKey, history, state) {
  // Fast path: obvious off-topic asks don't burn tokens
  const lastUser = [...history].reverse().find(m => m.role === "user")?.text || "";
  if (isOffTopic(lastUser)) return offTopicRedirect(lastUser);

  const portfolioSummary = summarisePortfolio(state);
  const newsContext = newsSnap.slice(0, 5).map(n => `- ${n.headline} (${n.source}) [${n.sentiment}]`).join("\n");
  const system = `${SYSTEM_PROMPT}\n\n# RUNTIME CONTEXT\n## User portfolio snapshot\n${portfolioSummary}\n\n## Latest market headlines\n${newsContext || "(none loaded)"}\n\n# TOOL USE\nYou have tools for live data: get_stock_price, get_crypto_price, search_stocks, get_market_news, get_user_portfolio. USE them whenever the user asks about any specific stock, crypto, the market right now, or their portfolio. Never guess prices or numbers — always call the tool.`;

  const messages = history.slice(-12).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));

  return await runAgent({ apiKey, system, messages });
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

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------
let root;

export function mountCoachPanel() {
  root = document.getElementById("coach-root");
  if (!root) return;

  // Pre-fetch news once at mount for context
  getNews({ limit: 12 }).then(items => { newsSnap = items || []; render(); }).catch(() => {});

  render();
  subscribe(render);

  // FAB for mobile
  const fab = document.createElement("button");
  fab.className = "coach-fab";
  fab.setAttribute("aria-label", "Open coach");
  fab.innerHTML = `<span>💬</span>`;
  fab.addEventListener("click", () => {
    setSetting("coachPanelOpen", !getState().settings.coachPanelOpen);
  });
  document.body.appendChild(fab);

  const applyDock = () => {
    const state = getState();
    if (window.innerWidth >= 1280 && state.settings.coachPanelOpen) {
      document.body.classList.add("coach-docked");
    } else {
      document.body.classList.remove("coach-docked");
      root.classList.toggle("open", state.settings.coachPanelOpen);
    }
  };
  applyDock();
  window.addEventListener("resize", applyDock);
  subscribe(applyDock);
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
          <div class="dim" style="font-size: 11px; font-weight: 400;">${usingLLM ? "Claude-powered · finance only" : "Finance coach · template mode"}</div>
        </div>
      </div>
      <button class="btn btn-ghost btn-icon" id="coach-close-btn" aria-label="Close coach">✕</button>
    </div>

    <div class="coach-messages" id="coach-messages-scroll">
      ${messages}
    </div>

    <form class="coach-chat-input" id="coach-form" autocomplete="off">
      <input id="coach-input" placeholder="Ask about SIPs, P/E, crashes..." maxlength="300" ${pending ? "disabled" : ""} />
      <button type="submit" id="coach-send" ${pending ? "disabled" : ""}>${pending ? "…" : "Send"}</button>
    </form>

    <div class="coach-footer">
      ${usingLLM ? "<span class=\"pill-brand\">● Grounded in your portfolio + news</span>" : "Add Anthropic key in Settings for Claude-powered replies"}
    </div>
  `;

  // Scroll to bottom of messages
  const ms = root.querySelector("#coach-messages-scroll");
  if (ms) ms.scrollTop = ms.scrollHeight;

  root.querySelector("#coach-close-btn")?.addEventListener("click", () => {
    setSetting("coachPanelOpen", false);
  });

  const form = root.querySelector("#coach-form");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    e.stopPropagation();          // don't let submit bubble anywhere weird
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

    // REAL LLM agent with tool-use. Tries user's key first, then backend proxy,
    // then (only if both fail) falls back to template matcher.
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
  // Combine user chat history + recent coach trade reflections
  const trade = (state.coachMessages || []).slice(-5).map(m => ({
    role: "assistant",
    text: m.payload?.reflection || "",
    context: m.payload?.historical_context,
    question: m.payload?.suggested_q,
    warning: m.payload?.warning_level,
    citations: m.payload?.citations || [],
    symbol: m.triggerSymbol,
    ts: m.ts,
    isTrade: true,
  })).filter(m => m.text);

  const chat = chatHistory.slice(-20).map(m => ({ ...m, isTrade: false }));

  const all = [...trade, ...chat].sort((a, b) => a.ts - b.ts).slice(-25);

  if (!all.length && !pending) {
    return `
      <div class="coach-empty">
        <span class="emoji">🎓</span>
        <div class="font-semi" style="color: var(--text-strong); font-size: var(--text-md);">Hi — I'm Saathi</div>
        <div class="text-sm">I talk about one thing: money. Ask me about SIPs, crashes, valuations, taxes, behavioral traps, or anything finfluencer-adjacent. I explain — I don't give tips.</div>
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
        e.preventDefault();
        e.stopPropagation();
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
