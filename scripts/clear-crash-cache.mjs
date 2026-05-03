#!/usr/bin/env node
/**
 * clear-crash-cache.mjs — wipe ALL rows from the Supabase ai_response_cache
 * table where bucket = 'crash_replay'.
 *
 * One-shot admin tool. Run when:
 *   - You've deployed a code change that makes existing cached crash
 *     replays semantically wrong (wrong tickers, broken shape, etc.)
 *     and bumping CURRENT_PROMPT_VERSION isn't enough because you also
 *     want the DB rows physically gone.
 *
 * Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.vercel
 * (created by `vercel env pull .env.vercel --environment=production`).
 *
 * Usage:
 *   vercel env pull .env.vercel --environment=production
 *   node scripts/clear-crash-cache.mjs                # wipe crash_replay
 *   node scripts/clear-crash-cache.mjs --bucket explain   # wipe a different bucket
 *   node scripts/clear-crash-cache.mjs --dry-run     # show count, don't delete
 */

import fs from "node:fs";
import path from "node:path";

// Load .env.vercel into process.env (no dotenv dep; trivial parse).
const envPath = path.resolve(process.cwd(), ".env.vercel");
if (!fs.existsSync(envPath)) {
  console.error(`Missing ${envPath}. Run: vercel env pull .env.vercel --environment=production`);
  process.exit(1);
}
const envText = fs.readFileSync(envPath, "utf8");
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=("?)(.*?)\2\s*$/);
  if (m) process.env[m[1]] = m[3];
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in .env.vercel");
  process.exit(1);
}

const args = process.argv.slice(2);
function flag(name, def = null) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  return args[i + 1] ?? true;
}
const BUCKET = String(flag("bucket", "crash_replay"));
const DRY = flag("dry-run", false) === true || flag("dry-run", false) === "true";

// Count first
const countUrl = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/ai_response_cache?select=cache_key&bucket=eq.${encodeURIComponent(BUCKET)}`;
const countRes = await fetch(countUrl, {
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    Prefer: "count=exact",
    Range: "0-0",
  },
});
const contentRange = countRes.headers.get("content-range");
const total = contentRange ? Number(contentRange.split("/")[1]) : null;
console.log(`Bucket "${BUCKET}" has ${total ?? "(unknown)"} rows.`);

if (DRY) {
  console.log("DRY RUN — not deleting.");
  process.exit(0);
}
if (total === 0) {
  console.log("Nothing to delete.");
  process.exit(0);
}

const delUrl = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/ai_response_cache?bucket=eq.${encodeURIComponent(BUCKET)}`;
const delRes = await fetch(delUrl, {
  method: "DELETE",
  headers: {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    Prefer: "return=minimal",
  },
});
if (!delRes.ok) {
  console.error(`DELETE failed: ${delRes.status} ${await delRes.text().catch(() => "")}`);
  process.exit(1);
}
console.log(`Deleted ${total ?? "all"} rows from "${BUCKET}".`);
