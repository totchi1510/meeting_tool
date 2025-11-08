create table if not exists oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  account_email text,
  access_token text not null,
  refresh_token text,
  scope text,
  token_type text,
  expiry_date timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_oauth_tokens_provider on oauth_tokens(provider);

