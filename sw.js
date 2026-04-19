// =============================================================================
// SERVICE WORKER — Offline-first cache. Demo-day insurance against flaky WiFi.
// =============================================================================

const CACHE_NAME = "stocksaathi-v2";
const STATIC = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/main.css",
  "./css/components.css",
  "./js/app.js",
  "./js/state.js",
  "./js/money.js",
  "./js/router.js",
  "./js/auth/accounts.js",
  "./js/auth/email.js",
  "./js/features/transfers.js",
  "./js/components/nav.js",
  "./js/components/coachPanel.js",
  "./js/components/interventionModal.js",
  "./js/components/toast.js",
  "./js/components/charts.js",
  "./js/components/quantitySelector.js",
  "./js/coach/biasDetectors.js",
  "./js/coach/templates.js",
  "./js/coach/outputFilter.js",
  "./js/coach/orchestrator.js",
  "./js/coach/historicalAnalog.js",
  "./js/coach/anthropic.js",
  "./js/coach/persona.js",
  "./js/coach/liveData.js",
  "./js/coach/agent.js",
  "./js/db/supabase.js",
  "./js/db/sync.js",
  "./js/features/limitOrders.js",
  "./js/data/universe.js",
  "./js/data/prices.js",
  "./js/data/crashes.js",
  "./js/data/dips.js",
  "./js/data/leaderboard.js",
  "./js/data/marketData.js",
  "./js/data/news.js",
  "./js/pages/landing.js",
  "./js/pages/portfolio.js",
  "./js/pages/stocks.js",
  "./js/pages/stockDetail.js",
  "./js/pages/crashReplay.js",
  "./js/pages/leaderboard.js",
  "./js/pages/reportCard.js",
  "./js/pages/onboarding.js",
  "./js/pages/settings.js",
  "./js/pages/login.js",
  "./js/pages/register.js",
  "./js/pages/friends.js",
  "./js/pages/news.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache external APIs — always network
  const externalHosts = ["anthropic.com", "api.anthropic.com", "finnhub.io",
    "api.groq.com", "api.coingecko.com",
    "api.mfapi.in", "query1.finance.yahoo.com", "query2.finance.yahoo.com",
    "api.rss2json.com", "corsproxy.io", "allorigins.win", "codetabs.com",
    "cdn.emailjs.com", "api.emailjs.com",
    "fonts.googleapis.com", "fonts.gstatic.com"];
  if (externalHosts.some(h => url.hostname.includes(h))) return;

  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(res => {
          if (event.request.method === "GET" && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        }).catch(() => cached);
      })
    );
  }
});
