-- ============================================================================
-- COACH MESSAGES — add session_id + surface columns so the per-turn
-- coach_messages table (already the single source of truth for every chat
-- turn, populated in real-time via logChatTurn / dbAddCoachMessage) can
-- back a rich multi-session chat UI on the client.
--
-- Previously the /chat page stored its multi-session envelope in the
-- separate `coach_chats` table, while logChatTurn silently wrote the
-- same turns into `coach_messages` as event_type='chat_user' /
-- 'chat_assistant' rows. This made coach_chats redundant — the canonical
-- conversation data was already reaching Supabase via coach_messages
-- regardless of the v138-v141 localStorage-sync chaos.
--
-- Adding these two columns lets us retire coach_chats entirely: the
-- client reconstructs its multi-session UI from coach_messages rows
-- grouped by session_id (falling back to time-gap heuristics for legacy
-- rows where session_id is NULL).
--
-- Columns are nullable so existing rows stay valid; new writes populate
-- them. Admin panel's existing time-gap grouping continues to work for
-- the legacy rows.
-- ============================================================================

alter table public.coach_messages
  add column if not exists session_id text,
  add column if not exists surface    text;

-- Enforce surface values (nullable, but if set must be one of these).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'coach_messages_surface_check'
  ) then
    alter table public.coach_messages
      add constraint coach_messages_surface_check
      check (surface is null or surface in ('chat_page', 'side_panel'));
  end if;
end $$;

-- Index for the new "group by session_id within a user" query pattern.
create index if not exists idx_coach_user_session_time
  on public.coach_messages (user_id, session_id, created_at);
