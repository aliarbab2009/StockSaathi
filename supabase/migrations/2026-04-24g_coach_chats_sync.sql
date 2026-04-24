-- ============================================================================
-- COACH CHATS — cross-device sync for the AI coach chat history.
--
-- Until now the coach's conversation history lived only in the user's
-- localStorage under keys ss.chat.sessions.v1 (multi-session /chat page)
-- and ss.coachchat.v1 (side-panel running log). Logging in on a new
-- device / browser / incognito window gave the user an empty coach — they
-- expected the chats to follow their account, same as trades and
-- portfolio. This migration adds one row per user, storing both keys as
-- JSONB blobs, so the client can push on every save and pull on login.
--
-- Shape is deliberately a single row keyed by user_id (not a row per
-- message) because (a) chat messages are only interesting as a flat log,
-- (b) the whole log fits comfortably in JSONB for any realistic usage,
-- (c) it keeps the write path a single upsert rather than N inserts per
-- message, which simplifies debouncing on the client.
-- ============================================================================

create table if not exists public.coach_chats (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  sessions_json jsonb not null default '{}'::jsonb,
  coach_log     jsonb not null default '[]'::jsonb,
  updated_at    timestamptz not null default now()
);

alter table public.coach_chats enable row level security;

drop policy if exists "coach_chats_own_read"  on public.coach_chats;
drop policy if exists "coach_chats_own_write" on public.coach_chats;

create policy "coach_chats_own_read" on public.coach_chats
  for select using (auth.uid() = user_id);

create policy "coach_chats_own_write" on public.coach_chats
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.coach_chats to authenticated;

create index if not exists coach_chats_updated_at_idx on public.coach_chats(updated_at);
