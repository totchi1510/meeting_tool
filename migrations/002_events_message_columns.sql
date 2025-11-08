alter table events add column if not exists slack_channel_id text;
alter table events add column if not exists slack_message_ts text;

