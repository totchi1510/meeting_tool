-- Add capacity to rooms
alter table rooms add column if not exists capacity int;

-- Event preferred room
alter table events add column if not exists room_id uuid references rooms(id);

-- Required attendees per event
create table if not exists event_required_users (
  event_id uuid references events(id) on delete cascade,
  slack_user_id text not null,
  primary key(event_id, slack_user_id)
);

