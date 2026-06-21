create table if not exists public.opening_lines (
  id uuid primary key default gen_random_uuid(),
  eco text not null,
  name text not null,
  pgn text not null,
  family text not null,
  source text not null default 'lichess/chess-openings',
  source_file text not null,
  move_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opening_lines_source_unique unique (source_file, eco, name, pgn),
  constraint opening_lines_move_count_check check (move_count >= 0)
);

create index if not exists opening_lines_eco_idx
  on public.opening_lines (eco);

create index if not exists opening_lines_family_idx
  on public.opening_lines (family);

create index if not exists opening_lines_name_idx
  on public.opening_lines (name);

alter table public.opening_lines enable row level security;

drop policy if exists "Anyone can read opening lines" on public.opening_lines;
create policy "Anyone can read opening lines"
  on public.opening_lines for select
  using (true);
