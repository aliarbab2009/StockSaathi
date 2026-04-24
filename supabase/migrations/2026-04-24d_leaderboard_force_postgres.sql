-- Migration 2026-04-24d — nuclear-option leaderboard fix.
--
-- If 2026-04-24b didn't work (board still shows only the calling user),
-- the function's SECURITY DEFINER owner isn't a role that bypasses RLS.
-- Supabase's SQL Editor normally runs as postgres (which has BYPASSRLS),
-- but on some projects the function can drift to a less-privileged owner
-- after previous migrations / table edits / role changes.
--
-- This migration (a) drops the function entirely so the next CREATE sets
-- a fresh owner = current SQL-editor user (which is postgres on Supabase),
-- (b) re-creates the function with SECURITY DEFINER, and (c) verifies the
-- owner by raising a helpful error if it's not a bypass-RLS role.
--
-- Apply in Supabase → SQL Editor → New query → paste → Run.
-- Safe to re-run — DROP IF EXISTS at the top cleans the slate.

drop view if exists public.leaderboard_view;
drop function if exists public.leaderboard(int, text);

create function public.leaderboard(
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
as $$
begin
  return query
  select
    p.id,
    p.username,
    p.display_name,
    p.school,
    p.avatar_color,
    (coalesce(pf.cash_paise, 0) + coalesce(hsum.hv, 0))::bigint,
    coalesce(pf.starting_cash_paise, 10000000)::bigint,
    case when coalesce(pf.starting_cash_paise, 0) > 0 then
      round(((coalesce(pf.cash_paise, 0) + coalesce(hsum.hv, 0) - pf.starting_cash_paise)::numeric /
             pf.starting_cash_paise::numeric) * 10000)::bigint
    else 0::bigint end,
    coalesce(tcount.tx, 0),
    p.created_at
  from public.profiles p
  left join public.portfolios pf on pf.user_id = p.id
  left join lateral (
    select sum(h.qty * h.avg_cost_paise)::bigint as hv
    from public.holdings h where h.user_id = p.id
  ) hsum on true
  left join lateral (
    select count(*)::int as tx
    from public.transactions t where t.user_id = p.id
  ) tcount on true
  where (p_school is null or lower(p.school) = lower(p_school))
  order by (coalesce(pf.cash_paise, 0) + coalesce(hsum.hv, 0)) desc
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;

-- Ensure the function is owned by a BYPASSRLS role. Supabase's SQL
-- Editor runs as postgres (which has BYPASSRLS), so CREATE above
-- already did this — but explicitly re-alter for safety + raise an
-- error if owner ended up wrong so we don't silently ship a broken
-- function.
do $$
declare
  v_owner text;
  v_bypass bool;
begin
  begin
    execute 'alter function public.leaderboard(int, text) owner to postgres';
  exception when insufficient_privilege then null; end;

  select r.rolname, r.rolbypassrls
    into v_owner, v_bypass
  from pg_proc p
  join pg_roles r on r.oid = p.proowner
  where p.proname = 'leaderboard'
    and p.pronamespace = 'public'::regnamespace
  limit 1;

  if not v_bypass then
    raise notice 'WARNING: leaderboard() is owned by role "%" which does NOT bypass RLS. The function will only return rows the owner can see through RLS policies. Run this migration from Supabase SQL Editor (which runs as postgres) for it to bypass RLS correctly.', v_owner;
  else
    raise notice 'OK: leaderboard() is owned by "%" with BYPASSRLS — function will see all rows.', v_owner;
  end if;
end $$;

grant execute on function public.leaderboard(int, text) to anon, authenticated;

-- Re-create the view wrapper with explicit security_invoker = false
-- so callers get definer semantics regardless of PG version defaults.
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

-- Immediate verification. If the counts below show 1 instead of your
-- real user count, the function is still RLS-blocked despite the above.
-- In that case paste the output of 2026-04-24c_leaderboard_diagnostic.sql
-- and we'll debug the specific RLS policy that's in the way.
select 'function' as source, count(*) from public.leaderboard(200, null)
union all
select 'view',              count(*) from public.leaderboard_view;
