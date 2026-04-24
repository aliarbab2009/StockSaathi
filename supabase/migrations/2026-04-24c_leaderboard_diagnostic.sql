-- Leaderboard DIAGNOSTIC — run this FIRST to tell us exactly where the
-- query is losing rows. Each query prints a diagnostic to the Results
-- panel. Paste each block separately into Supabase → SQL Editor → Run.
--
-- The goal: find out whether
--   (a) your profiles table actually has 17 rows (or fewer),
--   (b) every profile has a matching portfolio row,
--   (c) the function itself returns the right count,
--   (d) the leaderboard_view wrapper returns the same count, and
--   (e) who currently owns the function (should be postgres for SECURITY
--       DEFINER to bypass RLS).
--
-- Copy the output of each block back and we can decide which specific
-- fix applies.

-- =============================================================================
-- BLOCK 1 — how many real users exist, and who owns the leaderboard function
-- =============================================================================
select
  (select count(*) from public.profiles)               as profiles_total,
  (select count(*) from public.portfolios)             as portfolios_total,
  (select count(*) from public.profiles p
     join public.portfolios pf on pf.user_id = p.id)   as joined_total,
  (select count(*) from public.profiles where onboarded = true) as onboarded_true,
  (select count(*) from public.profiles where onboarded = false or onboarded is null) as onboarded_false,
  (select rolname from pg_roles r
     where r.oid = (select proowner from pg_proc
                    where proname = 'leaderboard'
                      and pronamespace = 'public'::regnamespace
                    limit 1)) as leaderboard_owner,
  (select prosecdef from pg_proc
     where proname = 'leaderboard'
       and pronamespace = 'public'::regnamespace
     limit 1) as is_security_definer,
  current_user as sql_editor_current_user,
  session_user as sql_editor_session_user;

-- =============================================================================
-- BLOCK 2 — call the function directly and count rows
-- =============================================================================
select count(*) as function_rows from public.leaderboard(200, null);

-- =============================================================================
-- BLOCK 3 — call the view and count rows (should match BLOCK 2)
-- =============================================================================
select count(*) as view_rows from public.leaderboard_view;

-- =============================================================================
-- BLOCK 4 — peek at actual rows from the view (first 5)
-- =============================================================================
select user_id, username, display_name, school, return_bps, trades
from public.leaderboard_view
limit 5;
