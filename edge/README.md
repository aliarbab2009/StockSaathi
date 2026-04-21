# `app/edge/` — Cloudflare Workers

Failover infrastructure in front of `stocksaathi.co.in`.

## `front-door/`

The request router. Bound to `stocksaathi.co.in/*`. Tries Vercel first; falls
back to Cloudflare Pages (static) or Fly.io (`/api/*.py`) on failure. The two
Edge-JS handlers (`/api/chat`, `/api/ai`) are bundled into this Worker directly
so they keep running even if both Vercel and Fly are down.

See [front-door/src/index.js](front-door/src/index.js) for the routing logic
and [front-door/wrangler.toml](front-door/wrangler.toml) for bindings.

## One-time setup

```bash
cd app/edge/front-door
npm install
npx wrangler kv namespace create HEALTH_KV
# paste the returned namespace ID into wrangler.toml

# Mirror secrets from Vercel:
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put CEREBRAS_API_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put SUPABASE_ANON_KEY
# optional:
npx wrangler secret put TEST_IP_ALLOWLIST   # comma-separated CF-Connecting-IPs allowed to use X-Force-Backup: 1

npx wrangler deploy
```

## Testing failover from your laptop

```bash
# Should return content from the backup API
curl -H "X-Force-Backup: 1" https://stocksaathi.co.in/api/health
# expect {"ok":true,"runtime":"fly",...}
```

(Your current IP must be in `TEST_IP_ALLOWLIST`.)
