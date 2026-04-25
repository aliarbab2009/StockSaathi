-- ============================================================================
-- MF MASTER — server-side mirror of AMFI's NAVAll.txt catalog.
--
-- Populated by /api/admin-sync-mf (daily Vercel cron) + the
-- scripts/build-mf-universe.mjs build-time generator. The front-end ships
-- mfFull.json for cold-load (~600 KB brotli); this table is the source of
-- truth for server-side queries (Ask Saathi MF search, future SIP analytics,
-- onboarding portfolio resolution by AMFI scheme code).
--
-- Refresh cadence: AMFI publishes NAVAll.txt once per business day around
-- 22:00 IST. Our cron runs at 17:00 UTC (22:30 IST) to pick up that day's
-- NAVs. Idempotent — re-running the same day is harmless.
-- ============================================================================

create table if not exists public.mf_master (
  symbol            text primary key,         -- "MF_<amfi_code>" — stable per scheme
  amfi_code         text not null unique,     -- e.g. "118718"
  name              text not null,            -- full scheme name
  amc               text not null,            -- e.g. "Aditya Birla Sun Life Mutual Fund"
  category          text not null,            -- AMFI's 47 SEBI sub-categories
  category_bucket   text not null,            -- our 7-bucket rollup: Equity / Debt / Hybrid / Index / Solution / Commodity / FoF
  plan_type         text not null,            -- "Direct" | "Regular"
  option_type       text not null,            -- "Growth" | "IDCW" | "Bonus"
  scheme_kind       text not null,            -- "Open" | "Close" | "Interval"
  isin_growth       text,
  isin_idcw         text,
  nav               numeric,
  nav_date          date,
  risk              text,                     -- "low" | "med" | "high"
  bench             text,                     -- best-effort benchmark string
  is_active         boolean not null default true,
  cached_at_ms      bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at        timestamptz not null default now()
);

alter table public.mf_master enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'mf_master_read') then
    create policy "mf_master_read" on public.mf_master
      for select using (true);
  end if;
end $$;
-- Writes via service role only (no insert/update/delete policies).

create index if not exists idx_mf_master_amc        on public.mf_master (amc);
create index if not exists idx_mf_master_bucket     on public.mf_master (category_bucket);
create index if not exists idx_mf_master_plan       on public.mf_master (plan_type);
create index if not exists idx_mf_master_active     on public.mf_master (is_active) where is_active = true;
create index if not exists idx_mf_master_isin_growth on public.mf_master (isin_growth) where isin_growth is not null;

comment on table public.mf_master is
  'AMFI mutual-fund master — every registered Indian MF scheme. Refreshed '
  'daily from https://portal.amfiindia.com/spages/NAVAll.txt by '
  '/api/admin-sync-mf. Replaces the 10-row hand-typed PLACEHOLDER_MFS list '
  'in app/js/data/curated.js.';
