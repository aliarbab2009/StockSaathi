# StockSaathi

**An AI-coached investment simulator for Indian teens.**
Real Indian stocks. Virtual ₹1,00,000. Behavioral reflection — not advice.

Built for the **Masters' Union AI Buildathon 2026** — problem statement F6.

---

## Run it

**Windows (double-click):**
```
run.bat
```

**Mac / Linux / Git Bash:**
```bash
./run.sh
```

**Any platform, manually:**
```bash
cd app
python -m http.server 7337
# then open http://localhost:7337/
```

Zero build step. Zero install. The app is pure HTML + CSS + vanilla ES modules.
Works fully offline after first load (service worker caches everything).

---

## What's in it

### Account system
- **Email + username + password** registration with PBKDF2 hashing (WebCrypto, never plaintext).
- Multi-user on the same device — each account gets its own scoped portfolio, trades, coach history, friends.
- Session management, profile editing, password change, account deletion.

### Real-time market data
- Primary: **Yahoo Finance** chart endpoint (public, CORS-enabled, no key needed).
- Optional: **Finnhub** with user-provided API key for premium fallback.
- Always-available: deterministic **synthetic** fallback so the app never breaks.
- Every quote shows a "Live" or "Cached" badge; source is transparent.

### News + sentiment
- A dedicated feed of Indian market headlines, filterable by *all / holdings / watchlist*.
- Keyword-based sentiment scorer tags every item as bullish / bearish / neutral.
- Optional Finnhub integration prepends real-time headlines.

### Trading
- 50 NSE-listed equities + 10 popular mutual funds.
- Quantity selector with stepper + slider + **25/50/75/100% quick buttons** — no more accidental sell-all.
- Confirmation modal with exact cost/proceeds before any order executes.
- Idempotent trades, integer paise math.

### Behavioral coach (core IP)
- **9 deterministic bias detectors**: panic-sell, pump-chase, FOMO, anchoring, concentration, sector concentration, disposition effect, churning, overtrading.
- **Panic-sell intervention modal** — fires BEFORE the sell with historical recovery data.
- **Historical analog lookup** — per-symbol recovery stats across 5 dip buckets (5/7/10/15/20%).
- **Template-first responses** — SEBI-safe by construction, works fully offline.
- **Output filter** blocks SEBI-actionable language.
- **Optional LLM augmentation** — paste Anthropic key for Claude Sonnet flavor.

### Peer-to-peer transfers
- Send virtual cash to any StockSaathi user by **@username** or email.
- **Transfer codes** — generate a code, share it, friend redeems on their device.
- Friends list, inbox, full transfer history.
- All transfers atomic against both sender and recipient state.

### Parent-consent email
- **EmailJS** integration for real email delivery (free 200/mo tier, fully client-side).
- **mailto:** fallback — always works, opens the user's email client with a pre-filled message.
- 6-digit consent code the parent approves and the teen enters.

### Time Travel (the wow moment)
- Pre-computed daily frames for **COVID 2020**, **GFC 2008**, **Demonetisation 2016**.
- Horizontal scrubber with 15-second auto-play.
- SVG dual-line chart: green = held, red dashed = panic-sold on day 3.
- Narration fades in at key frames.
- Fully offline.

### Leaderboard + Report Card
- Seeded with 50 realistic competitors; real StockSaathi users from other accounts on the device join automatically.
- Scope filters: Global / School / Friends.
- Report card: A+→D grade, bias counters, **self-override rate** (the metric that predicts outcomes), 8 earnable badges.

---

## Architecture

```
app/
├── index.html                      ← SPA shell
├── css/
│   ├── main.css                    ← design system (light theme primary)
│   └── components.css              ← per-component styles
├── js/
│   ├── app.js                      ← entry: theme, router, nav, coach, SW
│   ├── router.js                   ← hash-based + auth guards
│   ├── state.js                    ← per-user scoped store + localStorage
│   ├── money.js                    ← paise-first integer math
│   ├── auth/
│   │   ├── accounts.js             ← registration, login, PBKDF2 hashing
│   │   └── email.js                ← EmailJS + mailto fallback
│   ├── features/
│   │   └── transfers.js            ← P2P cash + transfer codes + friends
│   ├── coach/
│   │   ├── biasDetectors.js        ← 9 pure detectors
│   │   ├── historicalAnalog.js     ← dip lookup + formatting
│   │   ├── templates.js            ← response templates (primary)
│   │   ├── outputFilter.js         ← blocklist + schema validation
│   │   ├── orchestrator.js         ← event → message pipeline
│   │   └── anthropic.js            ← optional Claude augment
│   ├── components/
│   │   ├── nav.js                  ← sticky top nav + auth-aware menu
│   │   ├── coachPanel.js           ← right-docked + FAB
│   │   ├── interventionModal.js    ← panic-sell modal
│   │   ├── charts.js               ← pure SVG primitives
│   │   ├── quantitySelector.js     ← stepper + slider + 25/50/75/100%
│   │   └── toast.js                ← ephemeral notifications
│   ├── data/
│   │   ├── universe.js             ← 50 equities + 10 MFs
│   │   ├── prices.js               ← deterministic seeded history
│   │   ├── marketData.js           ← Yahoo + Finnhub + synthetic fallback
│   │   ├── news.js                 ← curated + Finnhub news + sentiment
│   │   ├── crashes.js              ← 3 crash scenarios
│   │   ├── dips.js                 ← per-symbol recovery stats
│   │   └── leaderboard.js          ← 50 seeded competitors
│   └── pages/
│       ├── landing.js · login.js · register.js · onboarding.js
│       ├── portfolio.js · stocks.js · stockDetail.js · news.js
│       ├── crashReplay.js · leaderboard.js · reportCard.js
│       └── friends.js · settings.js
└── sw.js                           ← service worker (cache-first)
```

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search on Markets |
| `c` | Toggle coach panel |
| `Esc` | Close modal |

---

## Setting up EmailJS for real parent-consent emails

1. Sign up free at [emailjs.com](https://www.emailjs.com/) (200 emails/month).
2. Add an email service (Gmail/Outlook/etc.) → get a **Service ID**.
3. Create a template with variables `{{to_email}}`, `{{teen_name}}`, `{{consent_code}}`, `{{message}}` → get a **Template ID**.
4. Copy your **Public key** from Account → API Keys.
5. Paste all three into StockSaathi's Settings → Parent-consent email.

Without EmailJS, onboarding falls back to opening the user's email client with a pre-filled message — which works everywhere.

---

## Disclaimer

Virtual money only. StockSaathi provides behavioral reflection, not investment advice.
Past performance does not guarantee future returns. No actual trades are executed.
Not affiliated with SEBI, NSE, BSE, or any broker.
