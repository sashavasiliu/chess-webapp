create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  sound_enabled boolean not null default true,
  default_opponent_depth integer not null default 10,
  default_eval_depth integer not null default 26
);

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null default 'stockfish',
  status text not null default 'active',
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  result text not null default 'ongoing',
  pgn text not null default '',
  timeline jsonb not null default '[]'::jsonb,
  current_ply integer not null default 0,
  opponent_depth integer not null default 10,
  player_color text not null default 'w',
  time_control_label text not null default 'Infinite',
  base_seconds integer,
  increment_seconds integer not null default 0,
  player_time_remaining_seconds integer,
  end_reason text not null default 'ongoing',
  constraint games_mode_check check (mode in ('stockfish')),
  constraint games_status_check check (status in ('active', 'completed')),
  constraint games_result_check check (result in ('white', 'black', 'draw', 'ongoing')),
  constraint games_player_color_check check (player_color in ('w', 'b')),
  constraint games_end_reason_check check (end_reason in ('ongoing', 'checkmate', 'timeout', 'resignation', 'draw')),
  constraint games_time_seconds_check check (
    (base_seconds is null or base_seconds > 0)
    and increment_seconds >= 0
    and (player_time_remaining_seconds is null or player_time_remaining_seconds >= 0)
  )
);

alter table public.games
  add column if not exists player_color text not null default 'w',
  add column if not exists time_control_label text not null default 'Infinite',
  add column if not exists base_seconds integer,
  add column if not exists increment_seconds integer not null default 0,
  add column if not exists player_time_remaining_seconds integer,
  add column if not exists end_reason text not null default 'ongoing',
  add column if not exists player_clock_started_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'games_player_color_check'
  ) then
    alter table public.games
      add constraint games_player_color_check check (player_color in ('w', 'b'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'games_end_reason_check'
  ) then
    alter table public.games
      add constraint games_end_reason_check check (end_reason in ('ongoing', 'checkmate', 'timeout', 'resignation', 'draw'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'games_time_seconds_check'
  ) then
    alter table public.games
      add constraint games_time_seconds_check check (
        (base_seconds is null or base_seconds > 0)
        and increment_seconds >= 0
        and (player_time_remaining_seconds is null or player_time_remaining_seconds >= 0)
      );
  end if;
end $$;

alter table public.profiles enable row level security;
alter table public.preferences enable row level security;
alter table public.games enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "Users can read own preferences" on public.preferences;
create policy "Users can read own preferences"
  on public.preferences for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own preferences" on public.preferences;
create policy "Users can insert own preferences"
  on public.preferences for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own preferences" on public.preferences;
create policy "Users can update own preferences"
  on public.preferences for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can read own games" on public.games;
create policy "Users can read own games"
  on public.games for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own games" on public.games;
create policy "Users can insert own games"
  on public.games for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own games" on public.games;
create policy "Users can update own games"
  on public.games for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own games" on public.games;
create policy "Users can delete own games"
  on public.games for delete
  using (auth.uid() = user_id);
