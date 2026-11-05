-- One row per demo run. The page reads it through the status webhook.
create table if not exists demo_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  status text not null check (status in ('running','done','partial','failed')),
  scenario jsonb not null,
  steps jsonb not null,
  report jsonb,
  error text
);
create index if not exists demo_runs_created_at on demo_runs (created_at desc);

-- Only n8n (the postgres user) reads this table; block the public API roles.
alter table demo_runs enable row level security;

-- n8n keeps its own tables (users, credentials, API keys...) in this same public schema,
-- and the summary workflow creates demo_summaries; none of them get RLS by default.
-- Nothing uses Supabase's Data API, so: RLS on every public table, and the API roles
-- (anon, authenticated) get no rights, also on tables n8n adds in later upgrades.
-- n8n connects as postgres, which owns these tables, so RLS doesn't affect it.
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname = 'public' and not rowsecurity loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
