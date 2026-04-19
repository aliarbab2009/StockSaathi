// =============================================================================
// CHAT — A simple coaching chatbot for teens learning to invest.
// Uses Claude (if API key set) or deterministic template responses as fallback.
// =============================================================================

import { getState } from "../state.js";

const CHAT_KEY = "ss.chatlog.v1";

const SYSTEM_PROMPT = `You are StockSaathi Coach — a warm, patient, financially-literate older sibling for Indian teens aged 13-18 learning to invest with virtual money.

Rules (strict):
- You are NOT a financial advisor. You never say "should buy", "should sell", "recommend", "target price", "guaranteed", "sure shot".
- You never name a specific stock as a good buy or sell.
- You educate: explain concepts (SIP, P/E, compounding, diversification, volatility), bust myths from finfluencer videos, and help reason through decisions.
- You are curious, direct, and kind. Plain English with occasional light Hinglish ("samajh aaya?") only when it fits naturally.
- Keep responses under 120 words. Use short paragraphs. Ask a follow-up question when it helps reflection.
- If asked for a stock tip or prediction, gently redirect to reasoning frameworks — never answer directly.

Context you know: user is using StockSaathi (a simulator), has ₹1,00,000 virtual money, and can practice trades without risk.`;

// Fallback FAQ responses for when LLM is unavailable
const TEMPLATE_REPLIES = [
  {
    match: /mutual fund|mf\b|sip/i,
    reply: "A mutual fund is a pool — hundreds of investors put money in, a fund manager buys a mix of stocks or bonds, and every investor gets a share of the mix. Why people like it: one ₹500 SIP gets you exposure to 50+ companies. Why it's not magic: the fund charges an expense ratio (usually 0.2%-2% a year) and the returns still depend on the market. What are you trying to understand about SIPs — the 'why it works' part or the 'how to pick one' part?",
  },
  {
    match: /p\/?e|price.{0,3}earn/i,
    reply: "P/E = price ÷ earnings per share. If a stock is ₹500 and earns ₹25/share a year, P/E is 20 — investors are paying ₹20 for every ₹1 of yearly profit. A P/E of 25 is average for Indian large-caps. Above 50 usually means investors expect fast growth (and you're paying for it). Below 10 can mean either a bargain or trouble — you have to check why. What company are you looking at?",
  },
  {
    match: /compound|compounding|8.{0,3}wonder/i,
    reply: "Compounding is your returns earning their own returns. Invest ₹1,000/month from age 18 to 40 at ~12%/year — you end up with ~₹19 lakhs. The same ₹1,000/month from 28 to 40 gives ~₹5.5 lakhs. The 10 extra years matter more than the money. That's why 'start early' is the most boring — and most powerful — advice in investing. Want to try the math in the simulator?",
  },
  {
    match: /crash|dip|panic|sell.{0,10}(low|down|crash)/i,
    reply: "Crashes feel endless while they're happening. They're not. The 2020 COVID crash: Nifty lost 35% in 33 days, recovered fully in 5 months. The 2008 GFC was worse — took 2 years. Here's the thing: the people who panic-sold during both ended up buying back higher. Try our Time Travel feature — scrub through 2020 and watch 'held' vs 'panic-sold' diverge. It's the clearest lesson this app gives.",
  },
  {
    match: /diversif/i,
    reply: "Diversification is owning stuff that doesn't all move together. If you own 10 IT stocks, that's not diversified — when IT has a bad quarter, everything drops. If you own IT + banks + FMCG + an index fund, a rough quarter in one sector barely dents your portfolio. The rough rule: no single stock > 10-15%, no single sector > 30-40% unless you really know why.",
  },
  {
    match: /stock.{0,10}tip|what.{0,10}buy|which.{0,10}stock|should i buy|best stock/i,
    reply: "I can't give stock tips — not the app design. But I can help you build a checklist for making your own pick: What does the company do? Is revenue growing? Is profit growing faster than revenue? Is the P/E reasonable for the sector? Would you be okay if the stock dropped 30% tomorrow and took 18 months to recover? If you can answer those, you've done more research than 90% of retail buyers.",
  },
  {
    match: /risk|volatile|beta/i,
    reply: "Risk in investing = how much the price moves around. Beta measures it vs the market: beta 1 = moves with the market, beta 1.5 = moves 1.5× as much (both up and down). High-risk doesn't mean bad — it means swings are bigger. A teen with 30+ years ahead can take more risk than a 55-year-old. The real question is: can you sleep through a 30% drop without selling? If not, you're over-risked.",
  },
  {
    match: /tax|ltcg|stcg/i,
    reply: "In India: if you sell equity held <1 year, the profit is short-term capital gains (STCG) taxed at 20%. Held >1 year, long-term (LTCG) at 12.5% on profits above ₹1.25L/year. That's why 'long-term investing' isn't just a slogan — it's literally a tax break. But this is a simulator, so no real tax here.",
  },
  {
    match: /etf/i,
    reply: "ETF = Exchange-Traded Fund. It's a mutual fund that trades like a stock — you buy/sell on the exchange any time the market's open, at live prices. Expense ratios are usually very low (0.05%-0.5%). Nifty ETFs and gold ETFs are popular starting points. Trade-off vs index mutual funds: ETFs have lower fees but you need a demat account.",
  },
  {
    match: /finfluencer|influencer|youtube|instagram.{0,10}tip/i,
    reply: "Real talk: most finfluencers get paid if you click. Their incentive isn't your outcome — it's views. When someone says 'I turned ₹10k into ₹10L, here's how', they almost never show the 100 people who tried the same thing and lost. A useful filter: 'Does this person tell me what could go wrong as clearly as what could go right?' If no — scroll past.",
  },
  {
    match: /hi\b|hello|hey|namaste|start|help/i,
    reply: "Hey! I'm your StockSaathi Coach. Ask me anything about investing, the Indian markets, or things you've seen in finance videos that confused you. I won't tell you what to buy — that's not my job. But I can explain concepts, help you reason through decisions, and call out things that look like marketing rather than math. What's on your mind?",
  },
];

const DEFAULT_FALLBACK = "Good question. I can chat about: SIPs and mutual funds, P/E and valuation, compounding, diversification, risk, taxes (LTCG/STCG), ETFs, how to spot dodgy finfluencer advice, and how to think about crashes. What's the one you're most curious about?";

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

function matchTemplate(text) {
  for (const t of TEMPLATE_REPLIES) if (t.match.test(text)) return t.reply;
  return DEFAULT_FALLBACK;
}

export function renderChat(main) {
  render();

  function render() {
    const state = getState();
    const usingLLM = !!state.settings.anthropicKey;

    main.innerHTML = `
      <div style="max-width: 760px; margin: 0 auto;">
        <div style="margin-bottom: var(--sp-4);">
          <div class="flex items-center gap-3">
            <h1>Coach Chat</h1>
            <span class="data-badge"><span class="dot ${usingLLM ? "" : "offline"}"></span> ${usingLLM ? "Claude-powered" : "Template mode"}</span>
          </div>
          <p class="muted">Ask the StockSaathi Coach anything. It'll never tell you what to buy — but it'll help you think.</p>
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
          ${[
            "What is a mutual fund?",
            "How does compounding work?",
            "Should I sell when the market crashes?",
            "What's a reasonable P/E ratio?",
            "How do I spot finfluencer hype?",
          ].map(q => `<button class="filter-pill" data-q="${escapeAttr(q)}">${escapeHtml(q)}</button>`).join("")}
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
        <div style="margin: auto; text-align: center; color: var(--text-muted); max-width: 420px;">
          <div style="font-size: 40px; margin-bottom: var(--sp-3);">🎓</div>
          <div class="font-semi" style="color: var(--text-strong); margin-bottom: var(--sp-2);">Your investing co-pilot</div>
          <div class="text-sm">Ask about SIPs, mutual funds, compounding, crashes, or anything finfluencer-adjacent. The coach explains — it never advises.</div>
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
  // Re-render to show typing
  const main = document.getElementById("main");
  const mEl = main?.querySelector("#chat-messages");
  if (mEl) {
    mEl.innerHTML += renderTyping();
    mEl.scrollTop = mEl.scrollHeight;
  }

  const state = getState();
  const key = state.settings.anthropicKey;

  let replyText = null;
  if (key) {
    try {
      replyText = await callClaudeChat(key, chatLog);
    } catch (e) {
      console.warn("Claude chat failed, falling back:", e);
    }
  }
  if (!replyText) replyText = matchTemplate(userText);

  m_pending = false;
  pushAssistant(replyText);
}

async function callClaudeChat(apiKey, history) {
  const recent = history.slice(-12).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 300,
        temperature: 0.5,
        system: SYSTEM_PROMPT,
        messages: recent,
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.content?.[0]?.text?.trim() || null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
