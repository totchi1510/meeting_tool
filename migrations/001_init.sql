-- Enable required extension for gen_random_uuid
create extension if not exists pgcrypto;

-- Projects
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  gcal_color_id text
);

-- Events
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  title text not null,
  location text,
  status text check (status in ('planning','closed','fixed')) not null,
  deadline_at timestamptz not null,
  created_by text not null,
  created_at timestamptz default now()
);

-- Event options
create table if not exists event_options (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  unique(event_id, start_at, end_at)
);

-- Votes
create table if not exists votes (
  id uuid primary key default gen_random_uuid(),
  event_option_id uuid references event_options(id) on delete cascade,
  slack_user_id text not null,
  choice text check (choice in ('yes','no','maybe')) not null,
  voted_at timestamptz default now(),
  unique(event_option_id, slack_user_id)
);

-- Rooms (MVP: allow NULL room_id in bookings)
create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  calendar_id text,
  color text
);

-- Bookings
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references rooms(id),
  event_id uuid references events(id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  gcal_event_id text,
  unique(room_id, start_at, end_at)
);

-- User profiles
create table if not exists user_profiles (
  slack_user_id text primary key,
  display_name text,
  faculty text not null,
  year text not null,
  updated_at timestamptz default now()
);

-- Attendance logs (snapshot yes at decision)
create table if not exists attendance_logs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  slack_user_id text references user_profiles(slack_user_id),
  decided_option_id uuid references event_options(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  recorded_at timestamptz default now(),
  unique(event_id, slack_user_id)
);

-- Reminders/idempotency
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'remind_vote_before_minutes'
  ) then
    alter table events add column remind_vote_before_minutes int default 24*60;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'events' and column_name = 'remind_join_before_minutes'
  ) then
    alter table events add column remind_join_before_minutes int default 60;
  end if;
end $$;

create table if not exists reminders_sent (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  user_id text not null,
  type text check (type in ('vote','join')) not null,
  sent_at timestamptz default now(),
  unique(event_id, user_id, type)
);

