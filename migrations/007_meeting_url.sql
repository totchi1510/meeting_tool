-- Add meeting_url (online meeting link) to events
alter table events add column if not exists meeting_url text;

