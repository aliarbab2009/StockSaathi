// =============================================================================
// NEWS — Real-time Indian market news with sentiment + AI retail-angle tag.
// =============================================================================

import { getNews, fmtRelativeTime, labelSentiment } from "../data/news.js";
import { getState, subscribe } from "../state.js";

let filter = "all";    // all | holdings | watchlist
let newsCache = [];
let loading = true;
let _newsCancel = { cancelled: false };
// AI-tag memo: { [headlineHash]: { sentiment, tldr, loading } }. Keyed on
// the headline text itself so duplicates across sources dedupe naturally.
const aiTags = new Map();
let aiQueueRunning = 0;
// Bumped 3 → 10. Each request is small (180-token JSON via gemini-2.5-
// flash-lite), and Vercel's serverless function happily fans out — the
// old cap of 3 was the visible "loads one-by-one" symptom even with
// scroll-into-view enqueueing. With 10, a viewport of ~6 visible cards
// fires in parallel and lands almost simultaneously.
const AI_MAX_CONCURRENT = 10;
const aiQueue = [];

export function renderNews(main) {
  _newsCancel.cancelled = true;
  _newsCancel = { cancelled: false };
  const myToken = _newsCancel;

  loading = true;
  render(main);
  loadNews(main, myToken);
  const unsub = subscribe(() => { if (!myToken.cancelled) render(main); });
  const onLeave = () => { myToken.cancelled = true; unsub?.(); };
  window.addEventListener("hashchange", onLeave, { once: true });
}

async function loadNews(main, token) {
  try {
    const items = await getNews({ limit: 40 });
    if (token.cancelled) return;
    newsCache = items;
  } catch (e) {
    if (token.cancelled) return;
    console.warn("news load failed:", e);
    newsCache = [];
  }
  if (token.cancelled) return;
  loading = false;
  render(main);
}

function render(main) {
  const state = getState();
  const holdings = Object.keys(state.holdings || {});
  const wl = state.watchlist || [];

  let visible = newsCache;
  if (filter === "holdings") {
    if (holdings.length === 0) {
      visible = [];
    } else {
      visible = newsCache.filter(n => n.symbols?.length && n.symbols.some(s => holdings.includes(s)));
    }
  } else if (filter === "watchlist") {
    if (wl.length === 0) {
      visible = [];
    } else {
      visible = newsCache.filter(n => n.symbols?.length && n.symbols.some(s => wl.includes(s)));
    }
  }

  const countAll = newsCache.length;
  const countHoldings = holdings.length ? newsCache.filter(n => n.symbols?.length && n.symbols.some(s => holdings.includes(s))).length : 0;
  const countWatchlist = wl.length ? newsCache.filter(n => n.symbols?.length && n.symbols.some(s => wl.includes(s))).length : 0;

  main.innerHTML = `
    <div style="margin-bottom: var(--sp-5);">
      <div class="flex items-center gap-3 wrap">
        <h1>Market News</h1>
        <span class="data-badge"><span class="dot ${loading ? "offline" : ""}"></span> ${loading ? "Loading…" : "Live from RSS"}</span>
        <button class="btn btn-ghost btn-sm" id="refresh-btn">↻ Refresh</button>
      </div>
      <p class="muted">Real-time headlines from Moneycontrol, Economic Times, LiveMint, Business Standard. Click a story to open the original article.</p>
    </div>

    <div class="flex gap-2 wrap" style="margin-bottom: var(--sp-4);">
      <div class="lb-tabs">
        <button class="lb-tab ${filter === "all" ? "active" : ""}" data-filter="all">All news (${countAll})</button>
        <button class="lb-tab ${filter === "holdings" ? "active" : ""}" data-filter="holdings">My holdings (${countHoldings})</button>
        <button class="lb-tab ${filter === "watchlist" ? "active" : ""}" data-filter="watchlist">Watchlist (${countWatchlist})</button>
      </div>
    </div>

    ${loading
      ? `<div class="news-grid compact">${[1,2,3,4].map(() => `<div class="news-item"><div class="skeleton" style="height: 18px; width: 80%;"></div><div class="skeleton" style="height: 14px; width: 100%; margin-top: 12px;"></div><div class="skeleton" style="height: 14px; width: 60%; margin-top: 8px;"></div></div>`).join("")}</div>`
      : (visible.length === 0
        ? `<div class="empty-state"><span class="emoji">📰</span><h3>${filter === "all" ? "Couldn't load news" : filter === "holdings" ? "No news about your holdings" : "No news about your watchlist"}</h3><p>${filter === "all" ? "Market news feeds are temporarily unreachable. Try refreshing in a minute." : filter === "holdings" ? (holdings.length ? "None of your holdings are in the latest news cycle." : "Buy some stocks first — news will filter here automatically.") : (wl.length ? "None of your watchlist stocks are in the latest news cycle." : "Add stocks to your watchlist (★ icon) — news will filter here automatically.")}</p></div>`
        : `<div class="news-grid compact">${visible.map(renderNewsItem).join("")}</div>`)
    }
  `;

  main.querySelectorAll("[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => { filter = btn.dataset.filter; render(main); });
  });
  main.querySelector("#refresh-btn")?.addEventListener("click", () => {
    loading = true;
    render(main);
    loadNews(main);
  });

  main.querySelectorAll("[data-newsurl]").forEach(el => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const url = el.dataset.newsurl;
      if (url && url !== "#") window.open(url, "_blank", "noopener,noreferrer");
    });
  });

  // Viewport-aware AI tagging. Previously we eagerly enqueued the first
  // 20 items, which (a) left items 21+ permanently stuck on "Analysing…"
  // because they never ran, and (b) blocked items the user actually had
  // on screen behind items that were off-screen. Now we observe each
  // news-item card and only enqueue when it scrolls into view — so items
  // load in the order the user reads them, and items that are never
  // scrolled to are never queued (no wasted API calls, no stuck skeleton).
  const visibleMap = new Map(visible.map((n, i) => [headlineKey(n.headline), n]));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const hk = entry.target.dataset.aiHk;
      const n = hk && visibleMap.get(hk);
      if (n) enqueueAiTag(main, n);
      observer.unobserve(entry.target);  // one-shot per card
    }
  }, { rootMargin: "100px 0px" });  // fire ~100px before card is fully visible
  main.querySelectorAll("[data-ai-hk]").forEach(el => observer.observe(el));
}

function renderNewsItem(n) {
  const hk = headlineKey(n.headline);
  const ai = aiTags.get(hk);
  const aiBlock = ai && ai.tldr
    ? `<div class="news-ai-take sentiment-${escapeAttr(ai.sentiment)}" data-ai-hk="${escapeAttr(hk)}"><span class="news-ai-label">Saathi take</span><span class="news-ai-body">${escapeHtml(ai.tldr)}</span></div>`
    : `<div class="news-ai-take loading" data-ai-hk="${escapeAttr(hk)}"><span class="news-ai-label">Saathi take</span><span class="news-ai-body dim">Analysing…</span></div>`;
  return `
    <article class="news-item" data-newsurl="${escapeAttr(n.url)}" tabindex="0" role="link" aria-label="${escapeAttr(n.headline)}">
      <div class="meta">
        <span class="news-source">${escapeHtml(n.source)} · ${fmtRelativeTime(n.ts)}</span>
        <span class="sentiment ${ai?.sentiment || n.sentiment}">${labelSentiment(ai?.sentiment || n.sentiment)}</span>
      </div>
      <div class="headline">${escapeHtml(n.headline)}</div>
      ${n.summary ? `<div class="summary">${escapeHtml(n.summary)}</div>` : ""}
      ${aiBlock}
      <div class="flex gap-1 wrap items-center justify-between" style="margin-top: 6px;">
        ${n.symbols?.length ? `<div class="flex gap-1 wrap">${n.symbols.slice(0, 4).map(s => `<span class="pill pill-neutral" style="font-size: 10px;">${s}</span>`).join("")}</div>` : `<span></span>`}
        ${n.url && n.url !== "#" ? `<span class="text-xs brand">Read →</span>` : ""}
      </div>
    </article>
  `;
}

function headlineKey(headline) {
  return String(headline || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

function enqueueAiTag(main, n) {
  const hk = headlineKey(n.headline);
  if (!hk) return;
  const existing = aiTags.get(hk);
  if (existing && (existing.tldr || existing.loading)) return;
  aiTags.set(hk, { loading: true });
  aiQueue.push({ main, n, hk });
  pumpAiQueue();
}

async function pumpAiQueue() {
  while (aiQueueRunning < AI_MAX_CONCURRENT && aiQueue.length) {
    const job = aiQueue.shift();
    aiQueueRunning++;
    fetchAiTag(job).finally(() => {
      aiQueueRunning--;
      pumpAiQueue();
    });
  }
}

async function fetchAiTag({ main, n, hk }) {
  // Abort the fetch if the AI endpoint takes longer than 12 s. Without
  // this, a slow / hung /api/ai?op=news-tldr leaves every card stuck on
  // "Analysing…" forever — which is exactly what the user hit on a
  // screen of 4 news items that all timed out in parallel and never
  // fell back to the no-skeleton state.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch("/api/ai?op=news-tldr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headline: n.headline, source: n.source, symbols: n.symbols || [] }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error("http_" + r.status);
    const j = await r.json();
    if (!j?.tldr) throw new Error("no_tldr");
    aiTags.set(hk, { sentiment: j.sentiment || "neutral", tldr: j.tldr, loading: false });
    patchNewsItem(main, hk);
  } catch (e) {
    clearTimeout(timer);
    console.warn("[news-tldr] failed for", n.headline?.slice(0, 40), "·", e?.name || e?.message || e);
    aiTags.set(hk, { loading: false });
    // Quietly remove the skeleton for failed items so the card isn't stuck on "Analysing…"
    const el = main?.querySelector(`[data-ai-hk="${cssEscape(hk)}"]`);
    if (el) el.remove();
  }
}

function patchNewsItem(main, hk) {
  const ai = aiTags.get(hk);
  if (!ai || !ai.tldr) return;
  const el = main?.querySelector(`[data-ai-hk="${cssEscape(hk)}"]`);
  if (!el) return;
  el.className = `news-ai-take sentiment-${ai.sentiment}`;
  el.innerHTML = `<span class="news-ai-label">Saathi take</span><span class="news-ai-body">${escapeHtml(ai.tldr)}</span>`;
  // Also update the top-right sentiment pill on the same card to match
  // what the AI concluded (often more accurate than the keyword-based
  // sentiment from data/news.js).
  const card = el.closest(".news-item");
  const sentPill = card?.querySelector(".sentiment");
  if (sentPill) {
    sentPill.className = `sentiment ${ai.sentiment}`;
    sentPill.textContent = labelSentiment(ai.sentiment);
  }
}

function cssEscape(s) {
  if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
  return String(s).replace(/"/g, '\\"');
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
