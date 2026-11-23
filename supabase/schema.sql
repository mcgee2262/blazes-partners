-- Blaze's Partners — run this ONCE in Supabase: SQL Editor -> New query -> paste -> Run.
-- Makes 2 tables. Only the emails in `members` can see or change anything.

create table if not exists public.members (
  email text primary key,          -- lowercase login email
  name  text not null check (name in ('Blaise','Dad'))
);

create table if not exists public.entries (
  id         text primary key default gen_random_uuid()::text,
  kind       text not null,        -- job, expense, capital, move, fund_value, fund_out, todo, decision, meeting, settings
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists entries_kind_idx on public.entries (kind);

-- keeps updated_at fresh
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists entries_touch on public.entries;
create trigger entries_touch before update on public.entries
  for each row execute function public.touch_updated_at();

-- "is the signed-in user one of the two partners?"
create or replace function public.is_partner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m where m.email = lower(auth.jwt() ->> 'email'));
$$;
revoke all on function public.is_partner() from public, anon;
grant execute on function public.is_partner() to authenticated;

alter table public.members enable row level security;
alter table public.entries enable row level security;

drop policy if exists "partners read members" on public.members;
create policy "partners read members" on public.members
  for select to authenticated using ((select public.is_partner()));

drop policy if exists "partners read" on public.entries;
drop policy if exists "partners add" on public.entries;
drop policy if exists "partners edit" on public.entries;
drop policy if exists "partners delete" on public.entries;
create policy "partners read"   on public.entries for select to authenticated using ((select public.is_partner()));
create policy "partners add"    on public.entries for insert to authenticated with check ((select public.is_partner()));
create policy "partners edit"   on public.entries for update to authenticated using ((select public.is_partner())) with check ((select public.is_partner()));
create policy "partners delete" on public.entries for delete to authenticated using ((select public.is_partner()));

revoke all on public.members, public.entries from anon;

-- live updates on both phones
do $$ begin
  alter publication supabase_realtime add table public.entries;
exception when duplicate_object then null; end $$;

-- >>> EDIT THESE TWO LINES: put in the real login emails (lowercase), then run. <<<
insert into public.members (email, name) values
  ('blaise-email@example.com', 'Blaise'),
  ('dad-email@example.com',    'Dad')
on conflict (email) do update set name = excluded.name;
