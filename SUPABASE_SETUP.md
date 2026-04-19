# StockSaathi — 10-minute production setup

Ship to real users with a real Postgres backend, cross-device accounts, email from `accounts@stocksaathi.co.in`, and an LLM coach that handles any load.

---

## 1. Supabase project (3 min)

1. Go to **https://supabase.com** → **Start your project** → sign in with GitHub.
2. **New project**:
   - Name: `stocksaathi`
   - Database password: generate + save it
   - Region: `Asia South (Mumbai)` — lowest latency for Indian users
   - Plan: **Free** is fine for launch (500MB DB, 50k monthly active users, 2GB file storage). Upgrade later.
3. Wait ~90s for the project to provision.
4. Open **SQL Editor → New query** → paste the **entire contents** of `supabase/schema.sql` → **Run**.
   - Creates all tables, RPCs, RLS policies, triggers, the leaderboard view, and enables Realtime.
5. **Authentication → Providers → Email**:
   - Confirm email: **OFF** for launch (so users get in instantly). You can switch on later.
6. **Project Settings → API** → copy two values:
   - `Project URL` (looks like `https://xxxxxxxx.supabase.co`)
   - `anon public` key (long JWT, safe to expose — RLS is what protects data)

---

## 2. Vercel environment (2 min)

Project → **Settings → Environment Variables** — add/update these:

```
# Supabase (required for cross-device accounts, leaderboard, friends, transfers)
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...

# LLM — server-side Groq key, user never sees it (free tier, 500 tok/s)
GROQ_API_KEY=gsk_xxxxxxxx
CHAT_RATE_PER_HOUR=240

# Email — Resend with verified stocksaathi.co.in (see step 3)
RESEND_API_KEY=re_xxxxxxxx
RESEND_FROM=StockSaathi <accounts@stocksaathi.co.in>
SUPPORT_EMAIL=accounts@stocksaathi.co.in

# Rate limits are DISABLED by default (default 100000/hr).
IS_UPSTREAM=1
```

After adding these, **Deployments → ⋯ → Redeploy** the latest build so env vars take effect.

---

## 3. Custom email: `accounts@stocksaathi.co.in` (3 min)

Resend hands this to you in one panel.

1. **resend.com** → **Domains → Add Domain** → enter `stocksaathi.co.in`.
2. Resend shows 3 DNS records — **SPF (TXT)**, **DKIM (TXT)**, **MX** — copy each Name/Value exactly.
3. Your DNS provider (Cloudflare if you set that up earlier, otherwise your `.co.in` registrar) → add the 3 records as shown.
4. Back in Resend → **Verify**. Takes 1–5 min after DNS propagates.
5. Once the domain is **Verified** (green check), `RESEND_FROM=accounts@stocksaathi.co.in` above just works. No other changes needed.

---

## 4. Verify it works (1 min)

After redeploy:

```
https://stocksaathi.co.in/api/health
```

Should return:
```json
{
  "ok": true,
  "providers": {
    "supabase": true,
    "groq": true,
    "resend": true,
    "smtp": true,
    "anthropic": false
  }
}
```

All four of `supabase`, `groq`, `resend`, `smtp` should be **true**.

Now:
1. Open the live site → **Sign up** with a fresh email.
2. Open it on a **different device** (your phone) → **Log in** with the same email — you should see the same portfolio.
3. Sign up a second account on that phone → go to **Friends** → search the first account's username → **Add**.
4. Send them ₹500 → the first device sees it appear instantly.
5. Both accounts appear on the **Leaderboard** with real returns.

---

## 5. What's actually hardened for scale

- **Supabase free tier**: 500 concurrent DB connections, 50k MAU, 2M reads/month. For 200 concurrent pitch users, you'll use <5% of any limit.
- **Vercel hobby**: 100GB bandwidth/month, unlimited requests on the free plan. Upgrade to Pro ($20/month) only if you exceed.
- **Groq free tier**: 14,400 chat requests/day. With `CHAT_RATE_PER_HOUR=240` per-IP limit, one abuser can't drain it.
- **Stock prices**: server-side proxied through Yahoo Finance + 45-second cache. All 200 users hitting at once = 1 upstream call every 45s.
- **Atomic trades and transfers**: `apply_trade` and `apply_transfer` RPCs run inside a Postgres transaction with row-level locking. Zero race conditions even under contention.
- **RLS** on every table: a malicious user cannot read or write anyone else's data — enforced by Postgres itself.

---

## 6. Fallback if you don't set up Supabase

The app **still works without Supabase** — it falls back to per-browser localStorage. Useful for first-run or if Supabase is ever down. Set only `GROQ_API_KEY` and you already have a functioning deploy.

---

## 7. Monitor launch

- **Supabase dashboard** → **Reports** → live graphs of requests, errors, slow queries.
- **Vercel dashboard** → **Analytics** → requests per minute, error rate.
- **Resend dashboard** → delivered / bounced / complained emails.
- **Groq console** → requests / tokens used.

If any one service hits limits, the others keep running — the app gracefully degrades section by section.
