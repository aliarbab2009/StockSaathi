-- ============================================================================
-- FUNDAMENTALS CACHE — server-side per-symbol fundamentals snapshot.
--
-- Populated by the daily cron `/api/admin-sync-fundamentals`, read by
-- `/api/fundamentals` as Tier 0 (hot-path) and by the front-end via the
-- /api/fundamentals endpoint.
--
-- Source priority (filled by the cron at write time, see api/fundamentals.py
-- _merge): Yahoo /v7+/v10 (crumb-authed) → Tickertape unofficial API →
-- Yahoo /v8/chart anonymous. Whichever tier returned a non-null value wins.
--
-- 24h TTL governed at read time by FUNDAMENTALS_CACHE_TTL_MS env var.
-- Stale rows are bypassed and refreshed inline; cron reaper not needed
-- since rows are updated in place.
-- ============================================================================

create table if not exists public.fundamentals_cache (
  symbol               text primary key,
  name                 text,
  sector               text,
  industry             text,
  market_cap           numeric,        -- absolute INR (e.g. 17968417210368 for RELIANCE)
  pe_ratio             numeric,        -- Yahoo trailingPE
  pe_ttm               numeric,        -- Tickertape ttmPe (when present)
  pb_ratio             numeric,
  beta                 numeric,
  dividend_yield       numeric,        -- decimal fraction (0.0041 = 0.41%)
  eps                  numeric,
  roe                  numeric,        -- decimal fraction
  fifty_two_week_high  numeric,
  fifty_two_week_low   numeric,
  fifty_day_avg        numeric,
  two_hundred_day_avg  numeric,
  source               text,           -- '+' joined tier list (e.g. 'yahoo_v7+yahoo_v10+tickertape')
  cached_at_ms         bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at           timestamptz not null default now()
);

-- Public read so the anon key on the front end can hit /api/fundamentals
-- (which proxies the Supabase cache read internally; the table itself
-- doesn't need to be browser-exposed but read-RLS keeps options open).
alter table public.fundamentals_cache enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'fundamentals_cache_read') then
    create policy "fundamentals_cache_read" on public.fundamentals_cache
      for select using (true);
  end if;
end $$;
-- No write policy — service role bypasses RLS by design, so writes from the
-- cron + /api/fundamentals always work; client-side writes are blocked.

create index if not exists idx_fundamentals_cache_updated
  on public.fundamentals_cache (updated_at);
create index if not exists idx_fundamentals_cache_sector
  on public.fundamentals_cache (sector) where sector is not null;

comment on table public.fundamentals_cache is
  'Per-symbol fundamentals cache (PE/PB/MarketCap/Beta/DivYield/EPS/ROE etc). '
  'Refreshed daily by /api/admin-sync-fundamentals via Yahoo crumb + Tickertape. '
  'TTL 24h governed at read time. Replaces the hand-typed values in curated.js.';

-- ============================================================================
-- TICKERTAPE SID MAPPING — NSE symbol → Tickertape's "sid" identifier.
--
-- Tickertape's per-stock endpoints take their internal sid (e.g. RELIANCE →
-- "RELI", ADFFOODS → "AMRN"). The mapping is stable per stock so we cache
-- it here to skip the search round-trip on every fundamentals fetch.
-- ============================================================================

create table if not exists public.tickertape_sids (
  symbol      text primary key,    -- NSE ticker (e.g. RELIANCE)
  sid         text not null,       -- Tickertape sid (e.g. RELI)
  resolved_at timestamptz not null default now()
);

alter table public.tickertape_sids enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'tickertape_sids_read') then
    create policy "tickertape_sids_read" on public.tickertape_sids
      for select using (true);
  end if;
end $$;

comment on table public.tickertape_sids is
  'NSE symbol → Tickertape sid mapping. Resolved via /search?text=<symbol> on '
  'first sync, cached here. Sids do not change for a given listed company.';
