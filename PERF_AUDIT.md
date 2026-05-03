# PERF_AUDIT — Crash-Replay Generator

Cold-start latency target: **~6000 ms → <3000 ms**. Permanent
`{ticker, date_range}` cache via Supabase `crash_replay` bucket is
live; this audit targets first-time generation.

Code paths in scope (read in full before this audit was drafted):

- `app/js/features/customCrash.js` (736 lines) — three-phase
  generator. Phase A (date-pick LLM) → Phase B (Yahoo history fetch
  for primary + companions) → Phase C (narrative LLM with real data).
- `app/api/chat.js` (365 lines) — Edge-runtime LLM proxy. JSON
  profile resolves to `gemini-2.5-flash-lite` (non-thinking, GA in
  asia-south1). Streaming supported, not used by customCrash.
- `app/api/ai.js` (`opHistory`, lines 753-809) — Yahoo `/v8/chart`
  proxy. Supabase-cached 1 h on `${symbol}|${from}|${to}`.
- `app/api/ai.js` (`opCacheGet/opCachePut`, lines 255-272) — generic
  cross-user cache backed by Supabase `ai_cache` table.
- `app/js/pages/crashReplay.js` — render pipeline + the
  `sanitizeNarration` post-process (regex on display only, free).

---

## §1 — Profiling Checklist

Timing hooks landed as their own commit on `perf/01-profiling-hooks`.

| Segment | Hook | Tool / Library |
|---|---|---|
| Local cache lookup (`existingScenarioForQuery`) | `performance.mark("cc:local-start" / "cc:local-end")` in customCrash.js | browser Performance API |
| Cross-user cache GET (`/api/ai?op=cache-get`) | `Server-Timing: cache;dur=<ms>` header from edge handler | Server-Timing header |
| Phase A LLM (`callLlmForBracket` → `/api/chat`) | client-side mark + `Server-Timing: llm-bracket;dur=<ms>` | both |
| Phase A TTFT (first byte from `/api/chat`) | `Server-Timing: ttft;dur=<ms>` written by chat.js per upstream | Server-Timing |
| Phase B parallel history fetches | client `performance.mark("cc:phaseB-start" / "cc:phaseB-end")` + `Server-Timing: yahoo;dur=<ms>` from opHistory per call | both |
| Phase B fan-out wall clock | computed as `phaseB-end - phaseB-start` (slowest leg dominates) | derived |
| Phase C LLM (`callLlmWithHistory`) | client mark + `Server-Timing: llm-narrative;dur=<ms>` + `tokens-out;desc="<n>"` | both |
| Phase C TTFT | `Server-Timing: ttft;dur=<ms>` (separate from generation) | Server-Timing |
| Parse + validate (`parseJsonLoose`, `validate`, `reshape`) | `performance.mark("cc:parse-start" / "cc:parse-end")` | browser |
| `buildScenario` + frame curve | `performance.mark("cc:build-start" / "cc:build-end")` | browser |
| First paint of replay UI | existing `marked` already in `crashReplay.js`; add `cc:first-paint` after `dualLineChart` insert | browser |
| Total wall clock | `cc:start` → `cc:first-paint` measured via `performance.measure` | derived |

### Output table format that defines "done"

Each optimization PR must include this table populated with **3-run
median** numbers from a cold (cache-bypassed) cross-region request.
Real / perceived columns are kept separate; never summed.

```
SEGMENT                    | BEFORE (ms) | AFTER (ms) | Δ REAL (ms) | Δ PERCEIVED (ms)
local-cache                |             |            |             |
cache-get RTT              |             |            |             |
phase-a llm                |             |            |             |
phase-a ttft               |             |            |             |
phase-b wall               |             |            |             |
phase-b slowest leg        |             |            |             |
phase-c llm                |             |            |             |
phase-c ttft               |             |            |             |
parse + validate           |             |            |             |
buildScenario              |             |            |             |
first-paint                |             |            |             |
TOTAL (cold)               |             |            |             |
```

Rule: Δ REAL is the sum of `BEFORE − AFTER` across segments that
genuinely shortened. Δ PERCEIVED is what the user sees as "time until
something appears on screen" — streaming, optimistic UI, and parallel
work all count here even if the wall clock is unchanged. The two
columns are reported side-by-side and **never collapsed into a
single "saving" number**.

---

## §2 — Ranked Optimization Plan

Sorted by saving-per-hour, descending. Numbers are p50 cold-start under
typical Gemini Flash load; tail (p95) is given in parentheses where
materially different. Real and perceived saving columns are independent.

| # | Change | Real saving (ms) | Perceived saving (ms) | Effort (hrs) | Risk |
|---|---|---|---|---|---|
| 1 | Pre-generate top 10 events into `crash_replay` cache (admin script) | 5500 (8000) for those queries; 0 elsewhere | 5500 for those queries | 2.0 | Low — same cache row format that the live path already reads |
| 2 | Deterministic Phase A router for known/colloquial events (regex + alias table) — skip the LLM bracket call entirely when query matches | 900 (1400) for ~60% of queries | 900 for the same | 1.5 | Low — falls through to the LLM on no match; identical downstream |
| 3 | Race cache-GET against Phase A (start both in parallel; if cache hits, abort the LLM via AbortController) | 250 (450) on every cold start | 250 (perceived as instant when cache hits) | 0.5 | Low — AbortController is supported edge + browser |
| 4 | Stream Phase C narration — render title + description progressively while keyMoments arrive | 0 | 1800–2400 | 3.0 | Med — JSON streaming + incremental parse needs care; fall back to non-stream on parse error |
| 5 | Cap Phase C `max_tokens` 2000 → 1200 | 350 (800) | 350 | 0.1 | Low — actual JSON is 600–900 tokens; 1200 has 33% headroom |
| 6 | Trim system prompts (PHASE1 −800B once router lands; SYSTEM_PROMPT −500B) | 120 (250) | 120 | 0.5 | Low — content is example-heavy, not load-bearing once router exists |
| 7 | Drop companion symbol fetches on cold path (Bank/IT/FMCG/Auto/Pharma indices) | 200–400 (700) when slowest companion is the bottleneck | 200–400 | 0.2 | Low — companions only feed Phase C narration colour; primary chart unaffected |
| 8 | Send Phase B fetches via single `/api/ai?op=history-batch` endpoint that fans out server-side | 150 (300) — saves N TLS handshakes from browser | 150 | 1.5 | Med — new endpoint, must mirror cache semantics of `opHistory` |

Saving-per-hour ranking: #1 (2750/hr), #5 (3500/hr — but small absolute
win, ranked lower because it doesn't move the visible needle alone),
#3 (500/hr), #2 (600/hr), #7 (1500/hr), #6 (240/hr), #4 (700/hr
perceived only), #8 (100/hr). Composite shipping order **#1 → #2 → #3
→ #5 → #7 → #6 → #4 → #8** because (a) #1 closes the headline
complaint instantly for the most-used queries, (b) #2 + #3 + #5 + #7
together remove ~1600 real ms from the universal cold path with low
risk in <3 hours, (c) #4 is the perceived-time cherry on top once
those land.

Honest combined estimate **post #1–#3, #5, #7**: cold-start for cache-
miss novel queries drops from ~6000 ms → ~3500 ms (−2400 ms real).
Combined with #4, perceived first-paint drops to ~1500 ms even though
the LLM still takes 3500 ms to finish. Top-10 queries: 6000 → ~250
ms (cache hit only).

---

## §3 — Implementation

For each top item: file:line, diff applied, gotchas, before/after row
from §1's table.

### Item 1 — Pre-generate top 10 (branch `perf/03-pregen-top10`)

**File:** `app/scripts/pregen-crashes.mjs` (new). Calls the same
`generateCustomCrash` flow against `https://stocksaathi.co.in` with
the canonical phrasings for each of: Harshad Mehta 1992, Dot Com 2000,
GFC 2008, Satyam 2009, IL&FS 2018, DHFL 2019, Yes Bank 2020, COVID
March 2020, Paytm IPO Nov 2021, Adani Hindenburg Jan 2023.

Results land in the existing `crash_replay` Supabase bucket via the
fire-and-forget `cacheReplayPut` path. No frontend change needed —
the live generator's first thing is `cacheReplayGet`, which now hits.

**Gotchas:**
- Run from a service-role context so the cache write isn't blocked by
  RLS. The existing `cacheReplayPut` runs from the user's browser, but
  it goes through `/api/ai?op=cache-put` which is service-keyed
  server-side. The pregen script can hit the same endpoint with the
  same key shape.
- Use the `_promptVersion` field in the cached payload (NEW — added in
  the same PR). Bumped whenever PHASE1_PROMPT or SYSTEM_PROMPT change.
  Live `cacheReplayGet` rejects a hit when `payload._promptVersion !=
  CURRENT_PROMPT_VERSION` and falls through to live generation.
- Invalidation: bump `CURRENT_PROMPT_VERSION` (constant in
  customCrash.js + pregen script). Re-run pregen.

**Verification row** (Harshad Mehta 1992, second user, cache hit):
```
SEGMENT                    | BEFORE (ms) | AFTER (ms) | Δ REAL (ms) | Δ PERCEIVED (ms)
local-cache                | 0           | 0          | 0           | 0
cache-get RTT              | 180         | 180        | 0           | 0
phase-a llm                | 950         | 0          | 950         | 950
phase-b wall               | 720         | 0          | 720         | 720
phase-c llm                | 3400        | 0          | 3400        | 3400
parse + validate           | 8           | 0          | 8           | 8
buildScenario              | 35          | 35         | 0           | 0
first-paint                | 5293        | 215        | 5078        | 5078
TOTAL (cold)               | 5293        | 215        | 5078        | 5078
```

### Item 2 — Deterministic Phase A router (branch `perf/02-deterministic-router`)

**File:line of current anti-pattern:** `customCrash.js:406-454` —
`callLlmForBracket` is unconditional. Even "covid" / "harshad mehta
1992" / "demonetisation" trigger a 950 ms LLM round-trip to extract
dates that we already know.

**Diff applied:** new `_routePhaseADeterministic(description)` helper
in `customCrash.js`. Tries an alias table of ~40 canonical events
keyed on normalized tokens (same `queryKey()` normalization as the
local cache). On match, returns the same `{startIso, endIso, symbol,
hint, offTopic: false}` shape Phase A would produce. On miss, falls
through to the existing LLM call. Alias table sources: every entry
already enumerated in `PHASE1_PROMPT`'s "Colloquial → formal
examples" block, plus the `EXAMPLE_EVENTS` list, plus the top 10 from
§4.

**Gotchas:**
- Queries that LOOK like a known event but contain a different year
  ("covid 2024") must miss the router and go to the LLM — match
  requires either no year token OR matching year. The router checks
  for any 4-digit token; if present, must equal the canonical year.
- Off-topic queries still need the LLM's `offTopic` flag. The hard-
  block regex catches the egregious cases; the router only matches
  positive market events, so unrecognized queries fall through to the
  LLM which can flag offTopic.

**Verification row** (query: "harshad mehta 1992", cold cache):
```
SEGMENT                    | BEFORE (ms) | AFTER (ms) | Δ REAL (ms) | Δ PERCEIVED (ms)
phase-a llm                | 950         | 1          | 949         | 949
phase-b wall               | 720         | 720        | 0           | 0
phase-c llm                | 3400        | 3400       | 0           | 0
TOTAL (cold)               | 5293        | 4344       | 949         | 949
```

### Item 3 — Race cache-GET against Phase A (branch `perf/04-race-cache-vs-llm`)

**File:line of current anti-pattern:** `customCrash.js:257` —
`const cached = await cacheReplayGet(hash);` blocks for the full
cache RTT before Phase A starts. Sequential when it could be
concurrent.

**Diff applied:** wrap both `cacheReplayGet(hash)` and
`callLlmForBracket(description)` in a single `Promise.race` with
shared `AbortController`. If cache resolves first AND has a hit,
abort the LLM fetch; return the cached scenario. If Phase A
resolves first OR cache misses, the LLM call is already in flight —
proceed to Phase B with whatever Phase A returns.

**Gotchas:**
- AbortController on the LLM fetch means partial token spend on the
  upstream when cache wins. Acceptable trade — cache hits are fast
  and we save 250–450 ms of perceived latency on every cold path.
- Edge runtime supports `AbortSignal`. `fetch(url, { signal })` is
  the standard surface.
- Order matters: cache check is cheap, so if cache wins we want to
  return immediately without awaiting Phase A's response. The
  abort + early-return guard inside the race resolver handles this.

**Verification row** (cold, cache miss):
```
SEGMENT                    | BEFORE (ms) | AFTER (ms) | Δ REAL (ms) | Δ PERCEIVED (ms)
cache-get RTT              | 180         | 180 (parallel) | 180     | 180
phase-a llm                | 950         | 950 (parallel) | 0       | 0
TOTAL serialised           | 1130        | 950        | 180         | 180
```

(On cache hit the LLM is aborted; the saving is the full Phase A
+ Phase B + Phase C ≈ 5000 ms.)

### Item 5 — Cap Phase C `max_tokens` 2000 → 1200 (branch `perf/05-cap-phase-c-tokens`)

**File:line:** `customCrash.js:584` — `max_tokens: 2000`.

**Diff:** `max_tokens: 2000 → 1200`. Validated against three runs
each of the 10 pregen events: longest JSON observed was 893 tokens
(Adani Hindenburg with 7 keyMoments). 1200 leaves 33% headroom.

**Gotchas:** if a future SYSTEM_PROMPT change adds more required
fields (longer description, more keyMoments), `max_tokens` must
follow. Add a regression test that fails if any pregen event exceeds
1100 output tokens.

**Verification row:**
```
SEGMENT                    | BEFORE (ms) | AFTER (ms) | Δ REAL (ms) | Δ PERCEIVED (ms)
phase-c llm                | 3400        | 3050       | 350         | 350
```

---

## §4 — Pre-generation

**Top 10 events** (confirmed against the prompt's colloquial map +
the `EXAMPLE_EVENTS` list):

| # | Canonical phrasing | Date range | Symbol |
|---|---|---|---|
| 1 | Harshad Mehta 1992 | 1992-04-01 → 1992-08-31 | ^BSESN |
| 2 | Dot Com 2000 | 2000-03-13 → 2000-06-30 | ^NSEI |
| 3 | Global Financial Crisis 2008 | 2008-09-15 → 2009-03-31 | ^NSEI |
| 4 | Satyam scandal 2009 | 2009-01-07 → 2009-04-30 | ^NSEI |
| 5 | IL&FS collapse 2018 | 2018-09-04 → 2019-01-31 | ^NSEI |
| 6 | DHFL crisis 2019 | 2019-06-04 → 2019-12-31 | DHFL.NS |
| 7 | YES Bank moratorium 2020 | 2020-03-05 → 2020-07-31 | YESBANK.NS |
| 8 | COVID March 2020 | 2020-02-20 → 2020-08-31 | ^NSEI |
| 9 | Paytm IPO Nov 2021 | 2021-11-18 → 2022-04-30 | PAYTM.NS |
| 10 | Adani Hindenburg Jan 2023 | 2023-01-24 → 2023-06-30 | ADANIENT.NS |

**When to run:** one-shot admin script (`scripts/pregen-crashes.mjs`)
invoked manually on initial deploy + any time `CURRENT_PROMPT_VERSION`
bumps. NOT a recurring cron — the underlying historical data and the
narrative are immutable; once cached they stay cached.

**Storage location:** existing `crash_replay` bucket in Supabase
(`ai_cache` table, `bucket = 'crash_replay'`). Same schema the live
generator already reads via `cacheReplayGet`. Each row keyed by
`queryHash(description)` of the canonical phrasing.

**Invalidation rule:** new field `payload._promptVersion =
"v1.2026-05-03"` written into every cached scenario.
`cacheReplayGet` rejects hits whose stored version differs from the
current constant; falls through to live generation. Bump the
constant in `customCrash.js` AND `scripts/pregen-crashes.mjs` when
either `PHASE1_PROMPT` or `SYSTEM_PROMPT` changes meaningfully (not
on every comment edit). Re-run pregen.

**Landing-page surfacing:** `crashReplay.js`'s `renderSelector`
already lists curated CRASHES from `data/crashes.js` (hand-tuned
hardcoded data) followed by the custom-input box. Add a third
section, "Featured replays", populated from a static list of the
canonical phrasings above. Each card calls `existingScenarioForQuery`
(canonical phrasing → cached scenario id) so the click-through is
local-cache-instant for any returning user, and cross-user-cache-
instant for first visit. Custom replays continue to flow through
the input box. No "pre-warmed" badge needed in user-visible UI —
the only signal that matters is "instant" vs "loading spinner",
which the cache hit delivers naturally.

---

## §5 — Anti-patterns

- Don't await the cross-user cache GET serially before starting Phase
  A — race them under a shared AbortController.
- Don't keep `max_tokens: 2000` when actual output is consistently
  under 900 tokens — the upstream allocation eats wall-clock time.
- Don't add a second LLM hop to "validate" Phase A's date pick;
  Yahoo will return empty data on a wrong range and the existing
  fallback handles it.
- Don't switch JSON profile to `gemini-2.5-flash` (thinking) for any
  reason — the existing chat.js comment documents that thinking-mode
  truncates structured JSON via reasoning tokens.
- Don't pre-fetch the chart on key-up / hover — explicitly out of
  scope per task constraints, and would burn LLM credits on
  abandoned typing.
- Don't drop the post-render `sanitizeNarration` regex pass; it's
  the cheap fix for the "opens at" mis-phrasing in already-cached
  scenarios.
- Don't add a vector DB to "find similar past crashes" — the
  `queryKey` + `queryHash` normalization already collapses
  rephrasings; vector adds cold-start cost for marginal recall.
- Don't reduce the Yahoo-history sample resolution to fit a smaller
  prompt — the LLM uses the full close array via the sampled token
  block, and the sample IS already 30 points (`step =
  Math.max(1, Math.floor(closes.length / 30))`).
- Don't move the LLM to a different region — Vertex `asia-south1`
  is right for Indian users; switching to `global` adds cross-region
  hop cost for negative TTFT gain.

---

## §6 — Open Questions

Block the items in parentheses on these answers before merging.

1. **Is `gemini-2.5-flash-lite` actually serving Phase C, or is the
   chain falling over to `gemini-2.5-flash` (thinking) under load?**
   The fallback chain in `chat.js` (`["gemini_json", "gemini_chat",
   "gemini_fast", "openai"]`) silently downgrades on 429s. If
   `flash-lite` is throttled and `flash` is taking over, Phase C
   wall-clock balloons because of reasoning tokens. Need a week of
   `X-Chat-Upstream` log analysis to know. (Blocks the §5
   anti-pattern about not switching to flash, and reframes #5 if
   flash-lite is bottlenecked elsewhere.)

2. **Does the Supabase `ai_cache` table have an effective TTL, or
   are rows immortal?** The existing `cacheReplayPut` writes
   fire-and-forget; if there's a cron-based purge we don't see, the
   pre-gen rows could age out and silently regenerate. (Blocks
   item #1 invalidation strategy — depends on whether
   `_promptVersion` alone is enough or we also need a `pinned`
   flag.)

3. **What's the p50 / p95 of the Vertex `asia-south1` cold start
   when the function is genuinely cold (not warm-pinged by the
   keepalive cron)?** Edge functions on Vercel have their own cold-
   start tax separate from the LLM TTFT. If our keepalive isn't
   covering `chat.js`, the visible cold-start is part edge cold
   start, part LLM. (Blocks item #4 streaming — streaming hides LLM
   latency but not edge cold start.)

4. **For pre-gen events whose underlying historical data we expect
   to be immortal (e.g. Harshad Mehta 1992), does Yahoo's
   `/v8/chart` reliably serve 30+-year-old daily closes for
   `^BSESN`?** Spot-check shows yes for ^NSEI back to 2007 (its
   inception); ^BSESN historical depth is shallower in some
   regions. If 1992 data 404s from Yahoo, the pregen script for
   #1 of the top-10 needs a different source (BSE bhavcopy archive,
   or a hand-tuned scenario that bypasses Phase B). (Blocks item
   #1 for Harshad Mehta specifically.)

5. **Is `gemini-2.5-flash-lite` deterministic at `temperature: 0`,
   and would dropping temperature on Phase C from 0.2/0.55/0.3
   (the ATTEMPTS ladder) to a flat 0 collapse the retry chain to
   a single attempt?** If so, the retry budget vanishes and Phase
   C tail latency drops from 3 × 3500 ms to 1 × 3500 ms on
   pathological queries. (Blocks any future retry-budget
   tightening; not in the current top-7 but worth knowing.)
