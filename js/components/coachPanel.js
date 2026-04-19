// =============================================================================
// COACH PANEL — Interactive chat + coach reflections. Right-docked on desktop.
// Uses Claude (if API key in settings) or a smart template matcher grounded in
// the user's actual portfolio and latest news.
// =============================================================================

import { getState, subscribe, setSetting } from "../state.js";
import { getInstrument } from "../data/universe.js";
import { getNews } from "../data/news.js";
import { formatRupees, formatPct } from "../money.js";

const CHAT_LOG_KEY = "ss.coachchat.v1";

let chatHistory = loadChat();
let pending = false;
let newsSnap = [];   // latest news cache

const SYSTEM_PROMPT = `You are StockSaathi Coach — a warm, patient older sibling for Indian teens aged 13-18 learning to invest with virtual money (₹1,00,000 simulator).

RULES (strict):
- NEVER say "should buy", "should sell", "recommend", "target price", "guaranteed", "sure shot", "will go up".
- Never give a specific stock as a good buy or sell.
- Educate (SIP, P/E, compounding, diversification, volatility, taxes).
- Bust finfluencer myths. Help reason through decisions.
- Be warm, direct, curious. Plain English. Light Hinglish only when natural.
- Keep replies under 110 words. Short paragraphs. One follow-up question when useful.
- If asked for a tip/prediction, redirect to reasoning frameworks — never answer directly.
- You're given the user's portfolio snapshot and recent market news as context. Use it when relevant.`;

function loadChat() {
  try { const raw = localStorage.getItem(CHAT_LOG_KEY); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}
function saveChat() {
  try { localStorage.setItem(CHAT_LOG_KEY, JSON.stringify(chatHistory.slice(-80))); } catch {}
}

const TEMPLATES = [
  { m: /mutual fund|sip/i, r: () => "A mutual fund pools many investors' money into a single basket that a fund manager runs. A SIP (Systematic Investment Plan) just means you auto-invest a fixed amount every month. Why it's popular: one ₹500 SIP can give you exposure to 50+ companies. Why it's not magic: the fund charges an expense ratio (0.2%-2%/yr), and returns still depend on the market. What angle are you curious about — why it works, or how to pick one?" },
  { m: /p\/?e|price.{0,3}earn/i, r: () => "P/E = price ÷ earnings-per-share. If a ₹500 stock earns ₹25/share a year, its P/E is 20 — you pay ₹20 for every ₹1 of yearly profit. A P/E of ~25 is normal for Indian large-caps. Above 50 usually means fast growth is already priced in. Below 10 could be a bargain or a warning. Which stock are you looking at?" },
  { m: /compound|8.{0,3}wonder/i, r: () => "Compounding is returns earning their own returns. Invest ₹1,000/month from 18→40 at ~12%/yr, you end with roughly ₹19 lakh. Start at 28 instead of 18, same amount, end with ~₹5.5 lakh. The 10 extra years matter more than the money does. That's why 'start early' beats 'pick the perfect stock' every time." },
  { m: /crash|dip|panic|(should|must).{0,6}sell/i, r: () => "Crashes feel endless while they're happening. They rarely are. COVID 2020: Nifty lost 35% in 33 days, recovered in 5 months. 2008 GFC was worse, took ~2 years. The people who panic-sold in both almost always bought back higher. Try Time Travel — scrub 2020. The held-vs-panic-sold divergence is the clearest lesson this app gives." },
  { m: /diversif/i, r: () => "Diversification = own things that don't all move together. 10 IT stocks isn't diversified — they all drop when IT has a rough quarter. IT + banks + FMCG + an index fund is. Rough rule: no single stock >10-15%, no single sector >30-40% unless you really know why." },
  { m: /stock.{0,10}tip|what.{0,10}buy|which.{0,10}stock|should i buy|best stock|best to invest/i, r: () => "Not my job to give tips — but I'll help you build your own checklist: What does the company do? Is revenue growing? Is profit growing faster than revenue? Is the P/E reasonable for the sector? Would you be okay holding through a 30% drop that takes 18 months to recover? If you can answer those, you've done more homework than 90% of retail buyers." },
  { m: /risk|volatile|beta/i, r: () => "Risk in investing ≈ how much the price swings. Beta measures this vs the market: beta 1 = moves with index, beta 1.5 = swings 1.5× as much (both up AND down). High risk ≠ bad — a 16-year-old with 30+ years ahead can handle more volatility than a 55-year-old. The real question: could you sleep through a 30% drop without selling?" },
  { m: /tax|ltcg|stcg/i, r: () => "In India: sell equity held <1 year → Short-Term Capital Gains, 20%. Held >1 year → Long-Term, 12.5% on profit above ₹1.25L/yr. That's why 'long-term investing' is also 'lower-tax investing'. (StockSaathi is a simulator, so no real tax here.)" },
  { m: /etf/i, r: () => "ETF = Exchange-Traded Fund. Like a mutual fund, but it trades on the exchange any time the market's open — live prices. Expense ratios are very low (0.05%-0.5%). Nifty ETFs and gold ETFs are common starting points. Trade-off vs index MFs: ETFs are cheaper but need a demat account." },
  { m: /finfluencer|influencer|youtube|instagram.{0,10}tip|reel/i, r: () => "Real talk: most finfluencers get paid per click. Their incentive is views, not your outcome. When someone says 'I turned ₹10k into ₹10L', they never show the 100 people who lost trying the same playbook. A useful filter: does this person describe what could go WRONG as clearly as what could go right? If not — scroll past." },
  { m: /nifty|sensex|index/i, r: () => "Nifty 50 = top 50 NSE-listed companies by free-float market cap. Sensex = top 30 BSE-listed. They're rebalanced periodically, so 'buy the index' is essentially betting on the Indian economy. Historically returned ~12% CAGR long-term, with 3-4 rough years per decade. Index funds/ETFs let you own this basket cheaply." },
  { m: /gold|safe.{0,6}asset/i, r: () => "Gold in India is part investment, part cultural insurance. Over the last 20 years it's returned ~9-10% CAGR in rupee terms, but with long flat periods. Useful as a diversifier (it often zigs when equity zags), but as your ONLY investment it's slow compared to equities. 5-15% of portfolio is a common sizing." },
  { m: /hi\b|hello|hey|namaste|yo\b|help/i, r: () => "Hey! I'm your StockSaathi Coach. Ask me anything about investing, Indian markets, or things you've seen in finance videos that confused you. I won't tell you what to buy — but I can explain concepts, pressure-test your thinking, and call out hype. What's on your mind?" },
];

const DEFAULT_REPLY = "Good question. A few things I can actually help with: SIPs and mutual funds, valuation (P/E, P/B), compounding math, diversification, risk vs reward, Indian tax basics, ETFs, and how to read past market crashes. Pick one and I'll go deeper.";

function smartTemplateReply(userText, state) {
  for (const t of TEMPLATES) if (t.m.test(userText)) return t.r();

  // Symbol lookup — if user mentions a ticker we own, answer portfolio-contextual
  const allSyms = Object.keys(state.holdings || {});
  const textLower = userText.toLowerCase();
  for (const sym of allSyms) {
    if (textLower.includes(sym.toLowerCase())) {
      const inst = getInstrument(sym);
      const related = newsSnap.filter(n => n.symbols?.includes(sym)).slice(0, 2);
      const newsBit = related.length ? ` Recent headlines: ${related.map(r => `"${r.headline}" (${r.source})`).join("; ")}.` : "";
      return `You're holding ${inst?.name || sym}. I won't tell you what to do with it. But the useful questions are: (1) has the reason you bought it changed? (2) is it now too big or too small a % of your portfolio? (3) is there news that shifts the thesis?${newsBit}`;
    }
  }
  return DEFAULT_REPLY;
}

async function callClaudeChat(apiKey, history, state) {
  const portfolioSummary = summarisePortfolio(state);
  const newsContext = newsSnap.slice(0, 5).map(n => `- ${n.headline} (${n.source}) [${n.sentiment}]`).join("\n");
  const systemWithContext = `${SYSTEM_PROMPT}\n\nUSER CONTEXT:\n${portfolioSummary}\n\nRECENT MARKET NEWS:\n${newsContext || "(no news loaded)"}`;

  const recent = history.slice(-10).map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
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
        max_tokens: 260,
        temperature: 0.5,
        system: systemWithContext,
        messages: recent,
      }),
      signal: ctrl.signal,
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
          <div style="font-size: var(--text-md);">Coach</div>
          <div class="dim" style="font-size: 11px; font-weight: 400;">${usingLLM ? "Claude-powered" : "Interactive · Template mode"}</div>
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
    if (s.settings.anthropicKey) {
      reply = await callClaudeChat(s.settings.anthropicKey, chatHistory, s).catch(() => null);
    }
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
        <div class="font-semi" style="color: var(--text-strong); font-size: var(--text-md);">I'm your Coach</div>
        <div class="text-sm">Ask me about SIPs, valuations, crashes, diversification, or anything finfluencer-adjacent. I explain concepts — never tips.</div>
        <div class="flex-col gap-2" style="margin-top: var(--sp-3); width: 100%;">
          ${["What is a mutual fund?", "How does compounding work?", "Should I sell when the market drops?"].map(q =>
            `<button type="button" class="filter-pill" data-suggest="${escapeAttr(q)}" style="text-align: left; font-size: 11px;">💬 ${escapeHtml(q)}</button>`
          ).join("")}
        </div>
      </div>
    `;
  }

  setTimeout(() => {
    root?.querySelectorAll("[data-suggest]").forEach(btn => {
      btn.addEventListener("click", () => {
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
