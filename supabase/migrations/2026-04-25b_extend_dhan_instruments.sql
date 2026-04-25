-- ============================================================================
-- DHAN INSTRUMENTS — universe expansion (additive)
--
-- Extends public.dhan_instruments from a thin NSE→Dhan security_id mapping
-- into a richer instrument-master table that drives screeners, sector
-- filters, risk-tiered universe selection, and ETF/BOND support alongside
-- equities. All columns are added idempotently with sensible defaults so
-- existing rows (and the bulk loader from api-scrip-master.csv / build-
-- universe.mjs / admin-sync-instruments) stay valid.
--
-- Note: security_id is made nullable because rows from the build-universe
-- pipeline have no Dhan ID — only Dhan-master sync (separate path) populates
-- it. Removing NOT NULL keeps a single table; otherwise we'd need a join.
--
-- Indexes target the high-cardinality query patterns: filter by sector,
-- filter active-only, filter by kind, and trigram name search for the
-- /markets search box. Partial indexes on is_active keep them small.
-- ============================================================================

create extension if not exists pg_trgm;

-- Make security_id nullable (rows from the universe sync have no Dhan ID).
alter table public.dhan_instruments
  alter column security_id drop not null;

alter table public.dhan_instruments
  add column if not exists name         text,
  add column if not exists series       text,
  add column if not exists isin         text,
  add column if not exists sector       text,
  add column if not exists industry     text,
  add column if not exists idx_tags     integer       not null default 0,
  add column if not exists cap_bucket   text,
  add column if not exists risk_tier    text,
  add column if not exists tick_size    numeric(10,4),
  add column if not exists face_value   numeric(10,2),
  add column if not exists listing_date date,
  add column if not exists is_active    boolean       not null default true,
  add column if not exists kind         text          not null default 'EQUITY';

-- CHECK constraints — added separately because there's no `add column if
-- not exists ... check` form that skips the check on re-run.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'dhan_instruments_risk_tier_check') then
    alter table public.dhan_instruments
      add constraint dhan_instruments_risk_tier_check
      check (risk_tier is null or risk_tier in ('low','med','high'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dhan_instruments_kind_check') then
    alter table public.dhan_instruments
      add constraint dhan_instruments_kind_check
      check (kind in ('EQUITY','ETF','BOND'));
  end if;
end $$;

create index if not exists idx_dhan_sector_active
  on public.dhan_instruments (sector) where is_active;
create index if not exists idx_dhan_active
  on public.dhan_instruments (is_active);
create index if not exists idx_dhan_kind_active
  on public.dhan_instruments (kind) where is_active;
create index if not exists idx_dhan_name_trgm
  on public.dhan_instruments using gin (name gin_trgm_ops);

-- Comment on the table to document its dual role.
comment on table public.dhan_instruments is
  'NSE instrument master. Originally a Dhan symbol→security_id map; extended in 2026-04-25b to carry name/sector/series/risk/cap_bucket/idx_tags/kind for the full-universe screener. security_id is populated only for symbols mapped from Dhan api-scrip-master.csv. Refreshed daily by /api/admin-sync-instruments cron.';

-- Also fold migration 2026-04-25a (coach_messages session_id + surface).
-- These columns may already exist if 2026-04-25a was applied; the IF NOT
-- EXISTS guards make this safe to re-run.
alter table public.coach_messages
  add column if not exists session_id text,
  add column if not exists surface    text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'coach_messages_surface_check') then
    alter table public.coach_messages
      add constraint coach_messages_surface_check
      check (surface is null or surface in ('chat_page','side_panel'));
  end if;
end $$;
create index if not exists idx_coach_user_session_time
  on public.coach_messages (user_id, session_id, created_at);
