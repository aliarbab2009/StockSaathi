-- Migration 2026-04-24b — fix the leaderboard so it actually returns
-- everybody instead of only the calling user.
--
-- Problem observed after applying the first migration:
--   Before: leaderboard showed 13 users (most of them seeded via JS).
--   After:  leaderboard showed only the current user (me).
--
-- Root cause: the first migration recreated public.leaderboard() with
-- SECURITY DEFINER but Supabase's RLS on public.portfolios restricts
-- SELECT to rows where auth.uid() = user_id. Even inside a SECURITY
-- DEFINER function, if the function owner can't bypass that RLS (e.g.
-- the function got recreated with a non-superuser owner), the INNER
-- JOIN to portfolios silently drops every row that isn't the caller's.
-- Result: 1 row back.
--
-- This migration:
--   1. Sets row_security = off INSIDE the function via SET row_security
--      (so RLS is forcibly disabled for the duration of the function,
--      regardless of owner).
--   2. Reassigns ownership to the postgres superuser if possible
--      (Supabase SQL editor runs as postgres so this is a no-op on
--      fresh projects, but guarantees correctness on ones that drifted).
--   3. Re-grants execute to anon + authenticated.
--   4. Rebuilds the leaderboard_view wrapper around the function with
--      security_invoker=false so a caller querying the view still
--      benefits from the function's bypass.
--
-- Apply in Supabase → SQL Editor → New query → paste → Run.

create or replace function public.leaderboard(
  p_limit int default 100,
  p_school text default null
)
returns table (
  user_id uuid,
  username text,
  display_name text,
  school text,
  avatar_color text,
  portfolio_value_paise bigint,
  starting_cash_paise bigint,
  return_bps bigint,
  trades int,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  return query
  select
    p.id,
    p.username,
    p.display_name,
    p.school,
    p.avatar_color,
    (pf.cash_paise + coalesce(hsum.hv, 0))::bigint,
    pf.starting_cash_paise,
    case when pf.starting_cash_paise > 0 then
      round(((pf.cash_paise + coalesce(hsum.hv, 0) - pf.starting_cash_paise)::numeric /
             pf.starting_cash_paise::numeric) * 10000)::bigint
    else 0::bigint end,
    coalesce(tcount.tx, 0),
    p.created_at
  from public.profiles p
  join public.portfolios pf on pf.user_id = p.id
  left join lateral (
    select sum(h.qty * h.avg_cost_paise)::bigint as hv
    from public.holdings h where h.user_id = p.id
  ) hsum on true
  left join lateral (
    select count(*)::int as tx
    from public.transactions t where t.user_id = p.id
  ) tcount on true
  where (p_school is null or lower(p.school) = lower(p_school))
  order by (pf.cash_paise + coalesce(hsum.hv, 0)) desc
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;

-- Make sure the function is owned by postgres so SECURITY DEFINER
-- runs with superuser privileges (redundant with row_security=off but
-- cheap belt-and-suspenders).
do $$
begin
  begin
    execute 'alter function public.leaderboard(int, text) owner to postgres';
  exception when insufficient_privilege then
    -- Not running as postgres — skip. row_security=off above already
    -- covers the RLS-bypass case.
    null;
  end;
end $$;

grant execute on function public.leaderboard(int, text) to anon, authenticated;

drop view if exists public.leaderboard_view;
create view public.leaderboard_view
  with (security_invoker = false) as
  select * from public.leaderboard(200, null);

do $$
begin
  begin
    execute 'alter view public.leaderboard_view owner to postgres';
  exception when insufficient_privilege then null; end;
end $$;

grant select on public.leaderboard_view to anon, authenticated;

-- Quick verification query — run this after the migration completes
-- to confirm the board has your real user count. Expected: 17.
--
-- select count(*) from public.leaderboard_view;
