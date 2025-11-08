do $$
begin
  if not exists (
    select 1 from pg_indexes where tablename = 'bookings' and indexname = 'bookings_event_id_key'
  ) then
    alter table bookings add constraint bookings_event_id_key unique (event_id);
  end if;
end $$;

