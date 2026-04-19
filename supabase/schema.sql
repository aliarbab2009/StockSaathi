-- =============================================================================
-- StockSaathi — complete Postgres schema for Supabase.
-- Run this ONCE in the Supabase SQL editor (dashboard → SQL → New query).
-- Idempotent: safe to re-run after failed attempts.
-- =============================================================================

-- --------------------------------------------------------------------------
-- Extensions
-- --------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------
-- profiles  (extends auth.users with app-specific fields)
-- --------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text unique not null,
  display_name  text not null,
  email         text not null,
  age           int check (age is null or (age >= 13 and age <= 120)),
  school        text,
  class_code    text,
  city          text,
  risk_profile  text check (risk_profile is null or risk_profile in ('cautious','balanced','bold')),
  parent_email  text,
  parent_consent_at timestamptz,
  avatar_color  text default 'green',
  onboarded     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_profiles_username on public.profiles (lower(username));
create index if not exists idx_profiles_school   on public.profiles (lower(school));

-- --------------------------------------------------------------------------
-- portfolios  (1:1 with user)
-- --------------------------------------------------------------------------
create table if not exists public.portfolios (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  cash_paise           bigint not null default 10000000,
  starting_cash_paise  bigint not null default 10000000,
  updated_at           timestamptz not null default now()
);

-- --------------------------------------------------------------------------
-- holdings  (many per user, unique symbol)
-- --------------------------------------------------------------------------
create table if not exists public.holdings (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  symbol          text not null,
  qty             numeric(18,6) not null check (qty > 0),
  avg_cost_paise  bigint not null check (avg_cost_paise >= 0),
  first_bought_at timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, symbol)
);
create index if not exists idx_holdings_user on public.holdings (user_id);

-- --------------------------------------------------------------------------
-- transactions  (immutable log of every trade)
-- --------------------------------------------------------------------------
create table if not exists public.transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  symbol           text not null,
  side             text not null check (side in ('BUY','SELL')),
  qty              numeric(18,6) not null check (qty > 0),
  price_paise      bigint not null check (price_paise >= 0),
  value_paise      bigint not null check (value_paise >= 0),
  bias_flags       jsonb default '[]'::jsonb,
  idempotency_key  text,
  created_at       timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index if not exists idx_txn_user_time on public.transactions (user_id, created_at desc);

-- --------------------------------------------------------------------------
-- friends (directional, user -> friend; enforce both sides for bidirection)
-- --------------------------------------------------------------------------
create table if not exists public.friends (
  user_id    uuid not null references auth.users(id) on delete cascade,
  friend_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);
create index if not exists idx_friends_friend on public.friends (friend_id);

-- --------------------------------------------------------------------------
-- transfers (P2P cash moves; atomic via RPC below)
-- --------------------------------------------------------------------------
create table if not exists public.transfers (
  id            uuid primary key default gen_random_uuid(),
  sender_id     uuid not null references auth.users(id) on delete cascade,
  recipient_id  uuid references auth.users(id) on delete cascade,
  code          text unique,
  amount_paise  bigint not null check (amount_paise > 0),
  note          text,
  status        text not null default 'pending' check (status in ('pending','completed','cancelled')),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index if not exists idx_transfers_sender    on public.transfers (sender_id, created_at desc);
create index if not exists idx_transfers_recipient on public.transfers (recipient_id, created_at desc);
create index if not exists idx_transfers_code      on public.transfers (code) where code is not null;

-- --------------------------------------------------------------------------
-- coach_messages
-- --------------------------------------------------------------------------
create table if not exists public.coach_messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  event_type      text not null,
  trigger_symbol  text,
  payload         jsonb not null,
  model           text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_coach_user_time on public.coach_messages (user_id, created_at desc);

-- --------------------------------------------------------------------------
-- watchlist
-- --------------------------------------------------------------------------
create table if not exists public.watchlist (
  user_id   uuid not null references auth.users(id) on delete cascade,
  symbol    text not null,
  added_at  timestamptz not null default now(),
  primary key (user_id, symbol)
);

-- --------------------------------------------------------------------------
-- Atomic RPC: apply_trade
-- Debits cash + upserts holding (BUY) OR credits cash + decrements holding (SELL)
-- in one SQL transaction. Enforces cash/qty checks. Writes transaction row.
-- --------------------------------------------------------------------------
create or replace function public.apply_trade(
  p_symbol          text,
  p_side            text,
  p_qty             numeric,
  p_price_paise     bigint,
  p_idempotency_key text,
  p_bias_flags      jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id        uuid := auth.uid();
  v_value          bigint := (p_qty * p_price_paise)::bigint;
  v_existing_txn   public.transactions;
  v_holding        public.holdings;
  v_new_qty        numeric;
  v_new_avg        bigint;
  v_txn_id         uuid;
begin
  if v_user_id is null then
    raise exception 'auth.uid() is null — not logged in';
  end if;
  if p_side not in ('BUY','SELL') then
    raise exception 'invalid side: %', p_side;
  end if;
  if p_qty <= 0 then
    raise exception 'qty must be positive';
  end if;

  -- Idempotency: if we've already processed this key, return existing
  if p_idempotency_key is not null then
    select * into v_existing_txn
      from public.transactions
      where user_id = v_user_id and idempotency_key = p_idempotency_key
      limit 1;
    if found then
      return jsonb_build_object('ok', true, 'txn_id', v_existing_txn.id, 'idempotent', true);
    end if;
  end if;

  -- Lock portfolio row to avoid races
  perform 1 from public.portfolios where user_id = v_user_id for update;

  if p_side = 'BUY' then
    -- Debit cash
    update public.portfolios
      set cash_paise = cash_paise - v_value,
          updated_at = now()
      where user_id = v_user_id
        and cash_paise >= v_value
      returning cash_paise into v_new_qty;
    if not found then
      raise exception 'insufficient cash';
    end if;
    -- Upsert holding (new or increase qty + recalc avg cost)
    select * into v_holding from public.holdings
      where user_id = v_user_id and symbol = p_symbol for update;
    if found then
      v_new_qty := v_holding.qty + p_qty;
      v_new_avg := (((v_holding.avg_cost_paise::numeric * v_holding.qty) + v_value) / v_new_qty)::bigint;
      update public.holdings set
        qty = v_new_qty, avg_cost_paise = v_new_avg, updated_at = now()
        where id = v_holding.id;
    else
      insert into public.holdings (user_id, symbol, qty, avg_cost_paise)
        values (v_user_id, p_symbol, p_qty, p_price_paise);
    end if;
  else  -- SELL
    select * into v_holding from public.holdings
      where user_id = v_user_id and symbol = p_symbol for update;
    if not found or v_holding.qty < p_qty then
      raise exception 'insufficient holding';
    end if;
    v_new_qty := v_holding.qty - p_qty;
    if v_new_qty <= 1e-9 then
      delete from public.holdings where id = v_holding.id;
    else
      update public.holdings set qty = v_new_qty, updated_at = now() where id = v_holding.id;
    end if;
    update public.portfolios set cash_paise = cash_paise + v_value, updated_at = now()
      where user_id = v_user_id;
  end if;

  insert into public.transactions (user_id, symbol, side, qty, price_paise, value_paise, bias_flags, idempotency_key)
    values (v_user_id, p_symbol, p_side, p_qty, p_price_paise, v_value, p_bias_flags, p_idempotency_key)
    returning id into v_txn_id;

  return jsonb_build_object('ok', true, 'txn_id', v_txn_id);
end;
$$;

grant execute on function public.apply_trade(text, text, numeric, bigint, text, jsonb) to authenticated;

-- --------------------------------------------------------------------------
-- Atomic RPC: apply_transfer (P2P)
-- --------------------------------------------------------------------------
create or replace function public.apply_transfer(
  p_recipient_username text,
  p_amount_paise       bigint,
  p_note               text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender_id    uuid := auth.uid();
  v_recipient_id uuid;
  v_transfer_id  uuid;
begin
  if v_sender_id is null then
    raise exception 'auth.uid() is null';
  end if;
  if p_amount_paise <= 0 then
    raise exception 'amount must be positive';
  end if;

  select id into v_recipient_id from public.profiles
    where lower(username) = lower(p_recipient_username)
       or lower(email) = lower(p_recipient_username)
    limit 1;
  if v_recipient_id is null then
    raise exception 'recipient not found';
  end if;
  if v_recipient_id = v_sender_id then
    raise exception 'cannot send to self';
  end if;

  -- Debit sender (locked)
  update public.portfolios set cash_paise = cash_paise - p_amount_paise, updated_at = now()
    where user_id = v_sender_id and cash_paise >= p_amount_paise;
  if not found then
    raise exception 'insufficient cash';
  end if;

  -- Credit recipient (creates portfolio row if missing)
  insert into public.portfolios (user_id, cash_paise) values (v_recipient_id, p_amount_paise)
    on conflict (user_id) do update set
      cash_paise = public.portfolios.cash_paise + excluded.cash_paise,
      updated_at = now();

  insert into public.transfers (sender_id, recipient_id, amount_paise, note, status, completed_at)
    values (v_sender_id, v_recipient_id, p_amount_paise, p_note, 'completed', now())
    returning id into v_transfer_id;

  return jsonb_build_object('ok', true, 'transfer_id', v_transfer_id);
end;
$$;

grant execute on function public.apply_transfer(text, bigint, text) to authenticated;

-- --------------------------------------------------------------------------
-- Bootstrap: create profile + portfolio on signup
-- Trigger on auth.users insert — Supabase stores the user in auth.users,
-- we mirror into public.profiles with metadata and create a portfolio row.
-- --------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username      text := coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1));
  v_display_name  text := coalesce(new.raw_user_meta_data->>'display_name', v_username);
  v_avatar        text := coalesce(new.raw_user_meta_data->>'avatar_color', 'green');
  v_username_u    text := v_username;
  v_try           int := 0;
begin
  -- Ensure unique username
  while exists (select 1 from public.profiles where lower(username) = lower(v_username_u)) loop
    v_try := v_try + 1;
    v_username_u := v_username || v_try::text;
    exit when v_try > 999;
  end loop;

  insert into public.profiles (id, username, display_name, email, avatar_color)
    values (new.id, v_username_u, v_display_name, new.email, v_avatar);
  insert into public.portfolios (user_id) values (new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --------------------------------------------------------------------------
-- Leaderboard view (public read, aggregates only)
-- --------------------------------------------------------------------------
create or replace view public.leaderboard_view as
select
  p.id                as user_id,
  p.username,
  p.display_name,
  p.school,
  p.avatar_color,
  pf.cash_paise + coalesce(hsum.hv, 0) as portfolio_value_paise,
  pf.starting_cash_paise,
  case when pf.starting_cash_paise > 0 then
    round(((pf.cash_paise + coalesce(hsum.hv, 0) - pf.starting_cash_paise)::numeric /
           pf.starting_cash_paise::numeric) * 10000)
  else 0 end as return_bps,
  coalesce(tcount.tx, 0) as trades,
  p.onboarded,
  p.created_at
from public.profiles p
join public.portfolios pf on pf.user_id = p.id
left join lateral (
  select sum(h.qty * h.avg_cost_paise)::bigint as hv from public.holdings h where h.user_id = p.id
) hsum on true
left join lateral (
  select count(*)::int as tx from public.transactions t where t.user_id = p.id
) tcount on true
where p.onboarded = true;

grant select on public.leaderboard_view to anon, authenticated;

-- --------------------------------------------------------------------------
-- Row Level Security
-- --------------------------------------------------------------------------
alter table public.profiles       enable row level security;
alter table public.portfolios     enable row level security;
alter table public.holdings       enable row level security;
alter table public.transactions   enable row level security;
alter table public.friends        enable row level security;
alter table public.transfers      enable row level security;
alter table public.coach_messages enable row level security;
alter table public.watchlist      enable row level security;

-- profiles: readable by all (for username search, leaderboard, etc.)
drop policy if exists "profiles_read_all"      on public.profiles;
drop policy if exists "profiles_update_self"   on public.profiles;
drop policy if exists "profiles_insert_self"   on public.profiles;
create policy "profiles_read_all"    on public.profiles for select using (true);
create policy "profiles_update_self" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "profiles_insert_self" on public.profiles for insert with check (auth.uid() = id);

-- portfolios: only self
drop policy if exists "portfolios_self_all" on public.portfolios;
create policy "portfolios_self_all" on public.portfolios for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- holdings: only self
drop policy if exists "holdings_self_all" on public.holdings;
create policy "holdings_self_all" on public.holdings for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- transactions: only self (read + insert via RPC)
drop policy if exists "txn_self_read" on public.transactions;
drop policy if exists "txn_self_insert" on public.transactions;
create policy "txn_self_read"   on public.transactions for select using (auth.uid() = user_id);
create policy "txn_self_insert" on public.transactions for insert with check (auth.uid() = user_id);

-- friends: only self can read/mutate own rows
drop policy if exists "friends_self_all" on public.friends;
create policy "friends_self_all" on public.friends for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- transfers: sender or recipient can read
drop policy if exists "transfers_party_read" on public.transfers;
drop policy if exists "transfers_sender_insert" on public.transfers;
create policy "transfers_party_read"    on public.transfers for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);
create policy "transfers_sender_insert" on public.transfers for insert
  with check (auth.uid() = sender_id);

-- coach messages: only self
drop policy if exists "coach_self_all" on public.coach_messages;
create policy "coach_self_all" on public.coach_messages for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- watchlist: only self
drop policy if exists "watchlist_self_all" on public.watchlist;
create policy "watchlist_self_all" on public.watchlist for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- --------------------------------------------------------------------------
-- Realtime: publish leaderboard-affecting tables
-- --------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.portfolios;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.transfers;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.transactions;
exception when duplicate_object then null; end $$;

-- =============================================================================
-- Done. You can now run this schema once in Supabase SQL editor.
-- =============================================================================
