-- Услуга-команда: админ отмечает нескольких специалистов, они все входят в бронь.
alter table services add column if not exists all_specialists_required boolean not null default false;

-- Снимок состава брони: primary specialist_id оставляем для совместимости,
-- specialist_ids нужен для блокировки/лимитов всех участников.
alter table bookings add column if not exists specialist_ids jsonb;

update bookings
set specialist_ids = jsonb_build_array(specialist_id)
where specialist_id is not null and specialist_ids is null;
