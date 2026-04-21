// =============================================================================
// CHAT — A simple coaching chatbot for teens learning to invest.
// Uses the BYO LLM path (if API key set) or deterministic template responses
// as fallback.
// =============================================================================

import { getState } from "../state.js";
import { getInstrument } from "../data/universe.js";
import { SYSTEM_PROMPT, matchTemplate, isOffTopic, offTopicRedirect, STARTER_QUESTIONS } from "../coach/persona.js";
import { runAgent } from "../coach/agent.js";

const CHAT_KEY = "ss.chatlog.v1";

let chatLog = loadChat();

function loadChat() {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveChat() {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatLog.slice(-100))); } catch {}
}

function replyFor(text) {
  const state = getState();
  return matchTemplate(text, {
    holdings: state.holdings || {},
    symbolOf: getInstrument,
    newsItems: [],
  });
}

export function renderChat(main) {
  render();

  function render() {
    const state = getState();
    const userOwnKey = !!state.settings.llmApiKey;
    // The server always has Gemini configured now. Template mode no longer
    // exists as a runtime state — the old badge was lying. Show the actual
    // source of the LLM instead so the user has a clear mental model.
    const badgeText = userOwnKey ? "Your key · finance only" : "Gemini · finance only";

    main.innerHTML = `
      <div style="max-width: 760px; margin: 0 auto;">
        <div style="margin-bottom: var(--sp-4);">
          <div class="flex items-center gap-3">
            <h1>Saathi</h1>
            <span class="data-badge"><span class="dot"></span> ${badgeText}</span>
          </div>
          <p class="muted">I'm Saathi — your finance coach. Ask anything about money, investing, Indian markets, taxes, behavioral econ, or how a past crash played out. Out of scope: everything else.</p>
        </div>

        <div class="card" style="padding: 0; overflow: hidden;">
          <div id="chat-messages" style="height: 520px; overflow-y: auto; padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-3); background: var(--bg-soft);">
            ${renderMessages()}
          </div>

          <form id="chat-form" style="display: flex; gap: var(--sp-2); padding: var(--sp-3); border-top: 1px solid var(--divider); background: var(--surface);">
            <input
              id="chat-input"
              class="input"
              placeholder="Ask about SIPs, P/E, crashes, anything..."
              autocomplete="off"
              style="flex: 1;"
              maxlength="500"
            />
            <button class="btn btn-primary" id="chat-send" type="submit">Send</button>
          </form>
        </div>

        <div class="flex gap-2 wrap" style="margin-top: var(--sp-4);">
          ${STARTER_QUESTIONS.map(q => `<button class="filter-pill" data-q="${escapeAttr(q)}">${escapeHtml(q)}</button>`).join("")}
          <button class="filter-pill" id="chat-clear" style="color: var(--negative);">Clear chat</button>
        </div>
      </div>
    `;

    const input = main.querySelector("#chat-input");
    const form = main.querySelector("#chat-form");
    const messagesEl = main.querySelector("#chat-messages");
    messagesEl.scrollTop = messagesEl.scrollHeight;
    input.focus();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      pushUser(text);
      rerender();
      await sendAndReply(text);
      rerender();
    });

    main.querySelectorAll("[data-q]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const q = btn.dataset.q;
        input.value = q;
        form.dispatchEvent(new Event("submit"));
      });
    });

    main.querySelector("#chat-clear").addEventListener("click", () => {
      if (confirm("Clear chat history?")) {
        chatLog = [];
        saveChat();
        rerender();
      }
    });
  }

  function rerender() {
    const messagesEl = main.querySelector("#chat-messages");
    if (messagesEl) {
      messagesEl.innerHTML = renderMessages();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function renderMessages() {
    if (!chatLog.length) {
      return `
        <div style="margin: auto; text-align: center; color: var(--text-muted); max-width: 460px;">
          <div style="font-size: 40px; margin-bottom: var(--sp-3);">🎓</div>
          <div class="font-semi" style="color: var(--text-strong); margin-bottom: var(--sp-2);">Hi — I'm Saathi</div>
          <div class="text-sm">I talk about one thing: money. Ask about SIPs, crashes, valuation, taxes, or any finfluencer claim that felt off. I explain — I don't give tips. Ask me about cooking and I'll politely decline.</div>
        </div>
      `;
    }
    return chatLog.map(m => renderBubble(m)).join("") +
      (m_pending ? renderTyping() : "");
  }
}

let m_pending = false;

function renderBubble(m) {
  if (m.role === "user") {
    return `
      <div style="align-self: flex-end; max-width: 78%; background: var(--brand); color: white; padding: 10px 14px; border-radius: 16px 16px 4px 16px; font-size: var(--text-md); line-height: 1.5; box-shadow: var(--sh-xs);">
        ${escapeHtml(m.text)}
      </div>
    `;
  }
  return `
    <div style="align-self: flex-start; max-width: 82%; display: flex; gap: 10px; align-items: flex-start;">
      <div class="friend-avatar green" style="width: 28px; height: 28px; font-size: 11px; flex-shrink: 0;">SS</div>
      <div style="background: var(--surface); border: 1px solid var(--border); padding: 10px 14px; border-radius: 16px 16px 16px 4px; font-size: var(--text-md); line-height: 1.55; color: var(--text); box-shadow: var(--sh-xs);">
        ${escapeHtml(m.text)}
      </div>
    </div>
  `;
}

function renderTyping() {
  return `
    <div style="align-self: flex-start; display: flex; gap: 10px; align-items: flex-start;">
      <div class="friend-avatar green" style="width: 28px; height: 28px; font-size: 11px; flex-shrink: 0;">SS</div>
      <div style="background: var(--surface); border: 1px solid var(--border); padding: 12px 16px; border-radius: 16px;">
        <div class="coach-typing" style="padding: 0;"><span></span><span></span><span></span></div>
      </div>
    </div>
  `;
}

function pushUser(text) {
  chatLog.push({ role: "user", text, ts: Date.now() });
  saveChat();
}
function pushAssistant(text) {
  chatLog.push({ role: "assistant", text, ts: Date.now() });
  saveChat();
}

async function sendAndReply(userText) {
  m_pending = true;
  // Re-render to show typing indicator.
  const main = document.getElementById("main");
  const mEl = main?.querySelector("#chat-messages");
  if (mEl) {
    mEl.innerHTML += renderTyping();
    mEl.scrollTop = mEl.scrollHeight;
  }

  const state = getState();

  // New chat path: always call Gemini. No template fallback, no off-topic
  // pre-filter — if the user asks something off-topic Gemini politely
  // declines per the system prompt. Templates used to intercept "hello",
  // "are you gemini" etc. before the LLM ever saw them, which made the
  // bot feel dumb. Let the LLM handle ALL replies.
  let replyText = null;
  let errorText = null;
  try {
    const messages = chatLog.slice(-12).map(m => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text,
    }));
    const system = `${SYSTEM_PROMPT}\n\n# TOOL USE\nYou have tools for live data: get_stock_price, get_crypto_price, search_stocks, get_market_news, get_user_portfolio. USE them whenever the user asks about any specific stock, crypto, market state, or their portfolio. Never guess numbers — always call the tool.\n\n# TONE\nKeep replies conversational and short by default (1–3 sentences). Only go longer when the user asks for explanation or depth.`;
    replyText = await runAgent({
      apiKey: state.settings.llmApiKey || null,
      system,
      messages,
      // "fast" profile = Gemini Flash. ~3× faster than Pro on chit-chat,
      // plenty smart for finance Q&A. Crash-replay generation and other
      // heavy JSON tasks still use profile:"reasoning" via /api/ai.
      profile: "fast",
    });
  } catch (e) {
    console.warn("coach chat error:", e);
    errorText = "Couldn't reach Saathi right now. Try again in a moment.";
  }

  m_pending = false;
  if (replyText && replyText.trim()) {
    pushAssistant(replyText);
  } else {
    // No reply + no exception = upstream returned empty. Surface an honest
    // error instead of falling back to a canned template.
    pushAssistant(errorText || "Saathi couldn't answer that. Try rephrasing or asking again.");
  }
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
