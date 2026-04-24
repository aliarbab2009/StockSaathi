-- Migration: drop the onboarded = true filter from public.leaderboard().
--
-- Motivation: users who sign up but don't complete onboarding were
-- invisible on the leaderboard. With only a handful of users bothering
-- to finish the onboarding quiz, the board looked fake-empty (2 visible
-- of 17 signed-up users) even though everyone had a profile + portfolio.
--
-- Apply this in Supabase → SQL Editor → New query → paste → Run.
-- The function is CREATE OR REPLACE so it's safe to run repeatedly.
-- No DB migration tooling required.

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
as $$
begin
  return query
  select
    p.id,
    p.username,
    p.display_name,
    case when p_school is null then p.school else p.school end,
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
grant execute on function public.leaderboard(int, text) to anon, authenticated;

-- Refresh the view wrapper (idempotent).
drop view if exists public.leaderboard_view;
create or replace view public.leaderboard_view as
  select * from public.leaderboard(200, null);
grant select on public.leaderboard_view to anon, authenticated;
