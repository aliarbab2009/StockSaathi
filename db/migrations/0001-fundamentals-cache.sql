-- Migration: create fundamentals_cache + tickertape_sids tables
-- =============================================================================
-- Run this in the Supabase SQL editor (project: stocksaathi). Idempotent â€”
-- IF NOT EXISTS guards make re-runs harmless.
--
-- Why: /api/fundamentals + /api/screener + /api/admin-sync-fundamentals all
-- assume these tables exist. As of 2026-04-26 only `dhan_instruments` and
-- `quote_cache` exist in `public`, so:
--   - /api/fundamentals always falls through to upstream Yahoo/Tickertape
--     (cache_get returns None silently on the 404)
--   - /api/admin-sync-fundamentals's writes are no-ops (write_cache catches
--     exceptions and returns False)
--   - /api/screener returns 502 supabase_http_404 for every sortable query
--
-- After this migration runs, the daily admin-sync-fundamentals cron will
-- populate fundamentals_cache. The screener prefers Supabase over the
-- static JSON sidecar automatically once rows exist (Hotfix29b).
-- =============================================================================

-- 1. fundamentals_cache â€” one row per NSE EQUITY symbol with refreshed-daily
--    fundamentals. Schema mirrors the dict written by api/fundamentals.py
--    write_cache() (lines 129-169 of that file).
CREATE TABLE IF NOT EXISTS public.fundamentals_cache (
    symbol                 text PRIMARY KEY,
    name                   text,
    sector                 text,
    industry               text,
    market_cap             double precision,
    pe_ratio               double precision,
    pe_ttm                 double precision,
    pb_ratio               double precision,
    beta                   double precision,
    dividend_yield         double precision,
    eps                    double precision,
    roe                    double precision,
    debt_to_equity         double precision,
    fifty_two_week_high    double precision,
    fifty_two_week_low     double precision,
    fifty_day_avg          double precision,
    two_hundred_day_avg    double precision,
    source                 text,
    cached_at_ms           bigint
);

-- Indexes that match the screener's sort + filter patterns. Each index is
-- DESC because every "top N" query the screener supports orders by the
-- metric DESC (highest 52w high, biggest market cap, etc.). Columns the
-- screener doesn't sort by (industry, source, cached_at_ms) get no index.
CREATE INDEX IF NOT EXISTS idx_fundamentals_market_cap
    ON public.fundamentals_cache (market_cap DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_fundamentals_pe_ratio
    ON public.fundamentals_cache (pe_ratio DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_fundamentals_pb_ratio
    ON public.fundamentals_cache (pb_ratio DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_fundamentals_dividend_yield
    ON public.fundamentals_cache (dividend_yield DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_fundamentals_beta
    ON public.fundamentals_cache (beta DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_fundamentals_roe
    ON public.fundamentals_cache (roe DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_fundamentals_eps
    ON public.fundamentals_cache (eps DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_fundamentals_debt_to_equity
    ON public.fundamentals_cache (debt_to_equity DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_fundamentals_52w_high
    ON public.fundamentals_cache (fifty_two_week_high DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_fundamentals_52w_low
    ON public.fundamentals_cache (fifty_two_week_low DESC NULLS LAST);

-- RLS: anon role can SELECT (screener uses anon key from /api/screener;
-- /api/fundamentals also uses anon for the read tier). Service role
-- (used by /api/admin-sync-fundamentals) bypasses RLS automatically.
ALTER TABLE public.fundamentals_cache ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'fundamentals_cache'
          AND policyname = 'allow_anon_select'
    ) THEN
        CREATE POLICY allow_anon_select ON public.fundamentals_cache
            FOR SELECT
            TO anon
            USING (true);
    END IF;
END $$;


-- 2. tickertape_sids â€” cache the (NSE symbol -> Tickertape sid) mapping so
--    the daily fundamentals cron skips the search round-trip on subsequent
--    runs. Referenced by api/admin-sync-fundamentals.py warm_sid_cache().
CREATE TABLE IF NOT EXISTS public.tickertape_sids (
    symbol      text PRIMARY KEY,
    sid         text NOT NULL,
    cached_at_ms bigint
);

ALTER TABLE public.tickertape_sids ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'tickertape_sids'
          AND policyname = 'allow_anon_select'
    ) THEN
        CREATE POLICY allow_anon_select ON public.tickertape_sids
            FOR SELECT
            TO anon
            USING (true);
    END IF;
END $$;


-- =============================================================================
-- Verify after running:
--   SELECT count(*) FROM public.fundamentals_cache;        -- expect 0 initially
--   SELECT count(*) FROM public.tickertape_sids;            -- expect 0 initially
--
-- Then trigger the cron to populate (one-shot manual run):
--   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
--     "https://stocksaathi.co.in/api/admin-sync-fundamentals?offset=0&limit=400"
--
-- The cron is also auto-scheduled in vercel.json â€” verify under
-- "vercel.json" -> "crons" that admin-sync-fundamentals runs hourly or
-- daily. Each invocation refreshes 400 stocks, so the full ~2300 active
-- equity universe takes ~6 invocations to cover.
-- =============================================================================
