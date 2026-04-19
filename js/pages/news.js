// =============================================================================
// NEWS — Real-time Indian market news with sentiment. Filters work correctly.
// =============================================================================

import { getNews, fmtRelativeTime, labelSentiment } from "../data/news.js";
import { getState, subscribe } from "../state.js";

let filter = "all";    // all | holdings | watchlist
let newsCache = [];
let loading = true;

export function renderNews(main) {
  loading = true;
  render(main);
  loadNews(main);
  const unsub = subscribe(() => render(main));
  window.addEventListener("hashchange", () => unsub?.(), { once: true });
}

async function loadNews(main) {
  try {
    newsCache = await getNews({ limit: 40 });
  } catch (e) {
    console.warn("news load failed:", e);
    newsCache = [];
  }
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
}

function renderNewsItem(n) {
  return `
    <article class="news-item" data-newsurl="${escapeAttr(n.url)}" tabindex="0" role="link" aria-label="${escapeAttr(n.headline)}">
      <div class="meta">
        <span class="news-source">${escapeHtml(n.source)} · ${fmtRelativeTime(n.ts)}</span>
        <span class="sentiment ${n.sentiment}">${labelSentiment(n.sentiment)}</span>
      </div>
      <div class="headline">${escapeHtml(n.headline)}</div>
      ${n.summary ? `<div class="summary">${escapeHtml(n.summary)}</div>` : ""}
      <div class="flex gap-1 wrap items-center justify-between" style="margin-top: 6px;">
        ${n.symbols?.length ? `<div class="flex gap-1 wrap">${n.symbols.slice(0, 4).map(s => `<span class="pill pill-neutral" style="font-size: 10px;">${s}</span>`).join("")}</div>` : `<span></span>`}
        ${n.url && n.url !== "#" ? `<span class="text-xs brand">Read →</span>` : ""}
      </div>
    </article>
  `;
}

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = String(s ?? ""); return d.innerHTML; }
function escapeAttr(s) { return String(s ?? "").replace(/"/g, "&quot;").replace(/</g, "&lt;"); }
