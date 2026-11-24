-- Привязка push-подписки к брони: напоминание клиенту уходит только на устройство,
-- где включали напоминания для этой записи. Раньше подписка знала только студию,
-- и напоминания с уведомлениями владельцу получали все подписчики студии.
alter table push_subscriptions
  add column booking_id text references bookings(id) on delete cascade;

-- одно устройство может включить напоминания на нескольких бронях:
-- уникальность «студия + endpoint + бронь» вместо «студия + endpoint»
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'push_subscriptions'::regclass and contype = 'u'
  loop
    execute format('alter table push_subscriptions drop constraint %I', c.conname);
  end loop;
end $$;

create unique index push_subscriptions_studio_endpoint_booking_uq
  on push_subscriptions (studio_id, endpoint_hash, coalesce(booking_id, ''));

create index push_subscriptions_booking_idx
  on push_subscriptions (booking_id)
  where booking_id is not null;
