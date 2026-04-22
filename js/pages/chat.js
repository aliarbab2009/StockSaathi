// =============================================================================
// CHAT — A simple coaching chatbot for teens learning to invest.
// Uses the BYO LLM path (if API key set) or deterministic template responses
// as fallback.
// =============================================================================

import { getState } from "../state.js";
import { getInstrument } from "../data/universe.js";
import { SYSTEM_PROMPT, matchTemplate, isOffTopic, offTopicRedirect, STARTER_QUESTIONS } from "../coach/persona.js";
import { runAgent, streamChat, needsLiveData, logChatTurn } from "../coach/agent.js";

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
              placeholder="${m_pending ? "Wait for the response to finish…" : "Ask about SIPs, P/E, crashes, anything..."}"
              autocomplete="off"
              style="flex: 1;"
              maxlength="500"
              ${m_pending ? "disabled" : ""}
            />
            ${m_pending
              ? `<button class="btn btn-outline" id="chat-stop" type="button" title="Stop response">◼ Stop</button>`
              : `<button class="btn btn-primary" id="chat-send" type="submit">Send</button>`}
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
      if (m_pending) return;   // guardrail: don't queue sends while streaming
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      pushUser(text);
      rerender();
      await sendAndReply(text);
      rerender();
    });

    // Stop-button: aborts the in-flight stream. The sendAndReply handler
    // detects the aborted state, appends a "stopped" suffix, and releases
    // m_pending so the input re-enables.
    main.querySelector("#chat-stop")?.addEventListener("click", () => {
      if (m_abortController) m_abortController.abort();
    });

    main.querySelectorAll("[data-q]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (m_pending) return;
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
let m_abortController = null;

function renderBubble(m) {
  if (m.role === "user") {
    return `
      <div style="align-self: flex-end; max-width: 78%; background: var(--brand); color: white; padding: 10px 14px; border-radius: 16px 16px 4px 16px; font-size: var(--text-md); line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; box-shadow: var(--sh-xs);">
        ${escapeHtml(m.text)}
      </div>
    `;
  }
  return `
    <div style="align-self: flex-start; max-width: 82%; display: flex; gap: 10px; align-items: flex-start;">
      <div class="friend-avatar green" style="width: 28px; height: 28px; font-size: 11px; flex-shrink: 0;">SS</div>
      <div style="background: var(--surface); border: 1px solid var(--border); padding: 10px 14px; border-radius: 16px 16px 16px 4px; font-size: var(--text-md); line-height: 1.55; white-space: pre-wrap; word-wrap: break-word; color: var(--text); box-shadow: var(--sh-xs);">
        ${renderMarkdown(m.text)}
      </div>
    </div>
  `;
}

// Minimal safe Markdown renderer for chat bubbles. Escapes HTML first (so
// user/LLM content can't inject tags), then converts a whitelist of common
// Gemini-output patterns: **bold**, *italic*, `code`, auto-linked URLs.
// Paragraph spacing is handled by CSS white-space: pre-wrap on the bubble.
function renderMarkdown(text) {
  if (!text) return "";
  let s = escapeHtml(String(text));
  // Bold: **text** — run first so the single-* italic regex below doesn't
  // try to claim the same asterisks.
  s = s.replace(/\*\*([^\n*][^\n*]*?)\*\*/g, "<strong>$1</strong>");
  // Italic: single-* text *. Intentionally conservative — no words on
  // either side of the asterisks (e.g. "rate*up" isn't italic).
  s = s.replace(/(^|[\s(])\*([^\n*][^\n*]*?)\*(?=[\s.,!?)]|$)/g, "$1<em>$2</em>");
  // Inline code: `snippet`
  s = s.replace(/`([^`\n]+)`/g, "<code style=\"background:var(--bg-soft);padding:1px 4px;border-radius:3px;font-size:0.9em;\">$1</code>");
  // Auto-link bare URLs. Safe because HTML was escaped first so any raw
  // "http" from user content is already `http` not a tag attribute.
  s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, "$1<a href=\"$2\" target=\"_blank\" rel=\"noopener\" style=\"color:var(--brand);text-decoration:underline;\">$2</a>");
  return s;
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
  m_abortController = new AbortController();

  // Manually toggle the form DOM so the input disables + Send becomes Stop
  // without a full re-render (a full re-render would re-attach listeners
  // and move focus, disrupting the user's typing rhythm).
  const outer = document.getElementById("main");
  const input = outer?.querySelector("#chat-input");
  const sendBtn = outer?.querySelector("#chat-send");
  if (input) {
    // readonly (not disabled) — keeps the caret blinking + focus on the
    // input, just blocks typing. Feels natural: user still sees where
    // they'll type the next message the moment Saathi finishes.
    input.setAttribute("readonly", "readonly");
    input.placeholder = "Saathi is responding…";
    input.focus();
  }
  if (sendBtn) {
    sendBtn.outerHTML = `<button class="btn btn-outline" id="chat-stop" type="button" title="Stop response">◼ Stop</button>`;
    outer.querySelector("#chat-stop")?.addEventListener("click", () => {
      if (m_abortController) m_abortController.abort();
    });
  }

  const reRenderOuter = () => {
    // Only re-renders the messages region; the form swap above handles the
    // input + button state transitions without touching message content.
    const messagesEl = outer?.querySelector("#chat-messages");
    if (messagesEl) {
      messagesEl.innerHTML = "";
      for (const m of chatLog) messagesEl.innerHTML += renderBubble(m);
      if (m_pending && !chatLog.at(-1)?.streaming) messagesEl.innerHTML += renderTyping();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  };

  const restoreForm = () => {
    if (input) {
      input.removeAttribute("readonly");
      input.placeholder = "Ask about SIPs, P/E, crashes, anything...";
      input.focus();
    }
    const stopBtn = outer?.querySelector("#chat-stop");
    if (stopBtn) {
      stopBtn.outerHTML = `<button class="btn btn-primary" id="chat-send" type="submit">Send</button>`;
    }
  };

  const state = getState();
  const messages = chatLog.slice(-12).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));

  // Heuristic: does the message obviously need live data (stock price,
  // portfolio, crypto, news)? If yes, take the slower tool-use path with
  // runAgent. If no, stream tokens directly for instant feel — first
  // character typically visible in ~300ms.
  const wantTools = needsLiveData(userText);

  if (wantTools) {
    // Tool-use path: non-streaming, standard runAgent with TOOLS.
    reRenderOuter();   // show typing indicator
    let replyText = null;
    let errorText = null;
    try {
      const system = `${SYSTEM_PROMPT}\n\n# TOOL USE\nYou have tools for live data: get_stock_price, get_crypto_price, search_stocks, get_market_news, get_user_portfolio. USE them whenever the user asks about any specific stock, crypto, market state, or their portfolio. Never guess numbers — always call the tool.\n\n# TONE\nKeep replies conversational and short by default (1–3 sentences). Only go longer when the user asks for explanation or depth.`;
      replyText = await runAgent({
        apiKey: state.settings.llmApiKey || null,
        system,
        messages,
        // Tool-use path: "fast" maps to Gemini 3 Flash Preview which is
        // considerably more reliable than the Lite chat model at function
        // calling. Pays ~500ms extra latency but drops the "Saathi couldn't
        // answer that" failures on queries like "what's TCS at?" from ~80%
        // to near zero. Lite is kept for pure conversational chat only.
        profile: "fast",
      });
    } catch (e) {
      console.warn("coach chat tool path error:", e);
      errorText = "Couldn't reach Saathi right now. Try again in a moment.";
    }
    m_pending = false;
    m_abortController = null;
    if (replyText && replyText.trim()) {
      pushAssistant(replyText);
      logChatTurn({ userText, assistantText: replyText, model: "gemini-chat" });
    } else {
      pushAssistant(errorText || "Saathi couldn't answer that. Try rephrasing or asking again.");
    }
    restoreForm();
    return;
  }

  // Streaming path: push an empty placeholder bubble, then append each
  // token as it arrives. Gives an instant-feel first character.
  const placeholderIdx = chatLog.length;
  chatLog.push({ role: "assistant", text: "", ts: Date.now(), streaming: true });
  reRenderOuter();

  const system = `${SYSTEM_PROMPT}\n\n# TONE\nKeep replies conversational and short by default (1–3 sentences). Only go longer when the user asks for explanation or depth.`;
  let result = null;
  try {
    result = await streamChat({
      system,
      messages,
      profile: "chat",
      signal: m_abortController.signal,
      onToken: (delta) => {
        if (chatLog[placeholderIdx]) {
          chatLog[placeholderIdx].text += delta;
          reRenderOuter();
        }
      },
    });
  } catch (e) {
    console.warn("coach stream error:", e);
  }
  m_pending = false;
  m_abortController = null;
  const entry = chatLog[placeholderIdx];
  if (entry) {
    entry.streaming = false;
    if (result?.aborted) {
      // User clicked Stop — keep whatever streamed so far and add a warm
      // sign-off rather than the clinical "[stopped]".
      const suffix = "\n\n— ok, I'll stop there. Ping me again if you want me to keep going.";
      entry.text = entry.text.trim()
        ? entry.text.trim() + suffix
        : "No worries — tap send again whenever you're ready.";
    } else if (result?.error && !entry.text.trim()) {
      entry.text = "Hmm, I'm having trouble reaching my brain right now. Give it a sec and try again?";
    } else if (!entry.text.trim() && result?.text) {
      entry.text = result.text;
    } else if (!entry.text.trim()) {
      entry.text = "Hmm, I went quiet there. Ask me once more?";
    }
    saveChat();
    reRenderOuter();
    // Log the finished turn (not aborted, not error) so admin can review.
    if (!result?.aborted && !result?.error && entry.text && !entry.text.startsWith("Hmm")) {
      logChatTurn({ userText, assistantText: entry.text, model: "gemini-chat" });
    }
  }
  restoreForm();
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
