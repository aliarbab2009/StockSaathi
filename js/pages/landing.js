// =============================================================================
// LANDING — StockSaathi pitch page.
// =============================================================================

import { getState } from "../state.js";

export function renderLanding(main) {
  const state = getState();
  const isAuthed = state.isAuthed;
  const isOnboarded = state.user.onboarded;

  main.innerHTML = `
    <section class="hero">
      <div style="margin-bottom: var(--sp-5);">
        <span class="pill pill-brand">StockSaathi · Invest virtually · Learn for real</span>
      </div>
      <h1 class="tight">Invest virtually.<br /><span class="grad-accent">Learn for real.</span></h1>
      <p class="tagline">
        You've heard <em>"SIP karo"</em> on YouTube. You've never placed a real trade.
        StockSaathi gives you ₹1,00,000 of virtual money to practice with <strong>real Indian stocks and mutual funds</strong> —
        with an AI coach that reflects on every decision without ever telling you what to do.
      </p>

      <div class="cta-row">
        ${isAuthed && isOnboarded
          ? `<a href="#/portfolio" class="btn btn-primary btn-lg">Open portfolio</a>
             <a href="#/crash-replay" class="btn btn-ghost btn-lg">Try Time Travel</a>`
          : isAuthed
          ? `<a href="#/onboarding" class="btn btn-primary btn-lg">Finish onboarding</a>`
          : `<a href="#/register" class="btn btn-primary btn-lg">Create account →</a>
             <a href="#/login" class="btn btn-ghost btn-lg">I already have an account</a>`
        }
      </div>

      <div class="stat-row">
        <div class="stat">
          <span class="n tabular">92%</span>
          <span class="l">of Indian teens can't define a mutual fund — but they hear "SIP karo" daily.</span>
        </div>
        <div class="stat">
          <span class="n tabular">₹0</span>
          <span class="l">of real money at risk. Virtual ₹1,00,000 portfolio, real NSE/BSE prices.</span>
        </div>
        <div class="stat">
          <span class="n tabular">1st</span>
          <span class="l">AI coach grounded in historical recovery data — not generic advice.</span>
        </div>
      </div>
    </section>

    <section class="container" style="margin-top: var(--sp-16);">
      <div style="margin-bottom: var(--sp-6);">
        <h2 class="tight">How it works</h2>
        <p class="muted" style="margin-top: var(--sp-2);">Six mechanics. One outcome — you become the kind of investor who survives the next dip.</p>
      </div>

      <div class="feature-grid">
        <div class="feature-card">
          <span class="icon">📈</span>
          <h3>Real-time prices</h3>
          <p>Live NSE/BSE quotes via Yahoo Finance — with your own Finnhub key as a tier-up for faster refresh. Always a synthetic fallback so the app never breaks.</p>
        </div>
        <div class="feature-card">
          <span class="icon">🧠</span>
          <h3>Behavioral coach</h3>
          <p>Nine deterministic bias detectors flag panic-selling, FOMO, concentration, churning and more. The AI coach verbalises what code flagged — never recommends a trade.</p>
        </div>
        <div class="feature-card">
          <span class="icon">📰</span>
          <h3>News + sentiment</h3>
          <p>A clean feed of Indian market headlines tagged bullish, bearish, or neutral — so you can gauge the mood without doom-scrolling Twitter.</p>
        </div>
        <div class="feature-card">
          <span class="icon">⏱</span>
          <h3>Time Travel</h3>
          <p>Scrub a slider through COVID 2020, 2008 GFC, or Demonetisation 2016. Watch "held" vs "panic-sold on day 3" diverge in real time. Financial déjà vu.</p>
        </div>
        <div class="feature-card">
          <span class="icon">💸</span>
          <h3>Send & receive</h3>
          <p>Transfer virtual cash between StockSaathi users by @username, or generate shareable redeem codes. Great for classroom challenges and friendly bets.</p>
        </div>
        <div class="feature-card">
          <span class="icon">🏆</span>
          <h3>Leaderboard + Report Card</h3>
          <p>Compete with friends on return %, earn badges, and get a monthly grade that measures decision <em>quality</em>, not just returns. Self-override rate is the real flex.</p>
        </div>
      </div>
    </section>

    <section class="container" style="margin-top: var(--sp-12);">
      <div class="card" style="background: linear-gradient(135deg, var(--brand-soft), transparent); border-color: var(--brand);">
        <h2 class="tight">Preview the wow moment — no signup needed</h2>
        <p class="muted" style="max-width: 640px; margin: var(--sp-2) 0 var(--sp-4);">
          Scrub through the COVID-19 crash. Watch a ₹1,00,000 portfolio split into
          <span class="up font-semi">held</span> vs <span class="down font-semi">panic-sold on day 3</span>.
          The <span class="up font-bold">+38%</span> delta lands in under 10 seconds.
        </p>
        <a href="#/crash-replay/COVID_2020" class="btn btn-primary btn-lg">Run COVID 2020 →</a>
      </div>
    </section>

    <section class="container" style="margin: var(--sp-16) auto var(--sp-12);">
      <details class="card" style="padding: var(--sp-5);">
        <summary style="font-weight: 600; cursor: pointer; font-size: var(--text-base);">Why StockSaathi exists</summary>
        <div style="margin-top: var(--sp-4); color: var(--text-muted); line-height: 1.75; font-size: var(--text-md);">
          <p>
            Indian teens see 30-second "start SIP at 18, become crorepati by 40" videos constantly.
            <strong>92% of them cannot explain what a mutual fund is.</strong>
            Real brokerages bar minors (and rightly so). The gap: there's no safe place to make
            your first market mistakes and be coached through them.
          </p>
          <p style="margin-top: var(--sp-3);">
            Every existing Indian paper-trading app (Moneybhai, StockGro, Sensibull) is a broker-flavored
            game. None ground coaching in real recovery data. None intervene before a panic-sell fires.
            None let you replay history to see how similar decisions actually played out.
          </p>
          <p style="margin-top: var(--sp-3);">
            <strong>The moat:</strong> deterministic bias detection, cited historical analogs, SEBI-safe framing.
            The coach verbalises what a code-level engine flagged — it never freelances an opinion.
            That's the layer that makes an LLM safe to deploy for minors in Indian fintech.
          </p>
          <p style="margin-top: var(--sp-3); font-size: var(--text-xs); color: var(--text-dim);">
            All prices, unless your Finnhub API key is configured in Settings, are pulled directly from Yahoo Finance's public endpoint.
            No part of this product is investment advice, and it will never tell you to buy or sell a specific security.
          </p>
        </div>
      </details>
    </section>
  `;
}
