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
