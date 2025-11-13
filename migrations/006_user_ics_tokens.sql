create table if not exists user_ics_tokens (
  slack_user_id text primary key,
  token text unique not null,
  created_at timestamptz default now()
);

