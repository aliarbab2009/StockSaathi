# StockSaathi — project context for Claude

Vanilla-JS SPA + Python serverless (Vercel) + Postgres (Supabase). Virtual-money Indian stock-trading simulator for teens. Live at https://stocksaathi.co.in.

## Stack
- **Frontend:** vanilla JS modules (no framework, no build step), SW-cached, hash router
- **Backend:** Vercel Python serverless functions in `api/*.py`
- **Database:** Supabase Postgres, RLS-enforced, RPCs for cross-user reads
- **Data:** Yahoo Finance free tier (rate-limited for Vercel IPs) with Supabase `quote_cache` TTL layer on top
- **LLM:** Groq (Llama 3.3 70B), proxied via `api/chat.py` with pinned model + capped tokens

## Workflow rules
- **Always push + let Vercel deploy** after any task. User pre-authorised.
- **Push target:** `origin` remote — **only** `aliarbab2009/StockSaathi.git`. Never add a second pushurl. See `~/.claude/projects/G--StockSaathi/memory/feedback_stocksaathi_push_target.md`.
- **Style:** terse, blunt, no ceremony. User prefers honesty > padding.
- **SW cache bump:** every JS/CSS change → bump `CACHE_NAME` in `sw.js` (format `stocksaathi-vN-YYYYMMDDx`)

## Key endpoints
- `/api/live-quote?symbols=A,B,C` — **primary quote path**, cache-first Supabase + Dhan→Yahoo fallback
- `/api/history?symbol=X&range=1mo&interval=1d` — OHLC for charts
- `/api/fundamentals?symbol=X` — 3-tier fallback (v7 → v10 → v8/chart)
- `/api/chat` — LLM proxy
- `/api/send-consent` — parent email

## Full context
See `~/.claude/projects/G--StockSaathi/memory/project_handoff.md` for architecture, outstanding TODOs, known bugs, and Vercel/Supabase setup state.

## Do not
- Commit secrets (`.env` is gitignored)
- Force-push to main
- Rotate `GROQ_API_KEY` or `RESEND_API_KEY` (user declined despite Vercel's "Need to Rotate" warnings — their call)
- Hand-curate `universe.js` entries at scale — user is planning NSE-wide import; the architecture needs to move to a Supabase `instrument_master` table
