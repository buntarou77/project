-- K1: каталог мультиарендный — id уникален в пределах студии, а не глобально.
-- Составные PK; FK из bookings перепривязываем к составному ключу.
-- Предохранитель: дубликаты id внутри одной студии (их быть не должно) ловим
-- до смены PK, чтобы не потерять строки молча.

do $$
declare dup text;
begin
  select string_agg(t, ', ') into dup from (
    select 'specialists(' || studio_id || '/' || id || ')' as t
    from specialists group by studio_id, id having count(*) > 1
    union all
    select 'halls(' || studio_id || '/' || id || ')'
    from halls group by studio_id, id having count(*) > 1
    union all
    select 'services(' || studio_id || '/' || id || ')'
    from services group by studio_id, id having count(*) > 1
    union all
    select 'addons(' || studio_id || '/' || id || ')'
    from addons group by studio_id, id having count(*) > 1
    union all
    select 'portfolio(' || studio_id || '/' || id || ')'
    from portfolio group by studio_id, id having count(*) > 1
  ) all_dups;
  if dup is not null then
    raise exception 'K1: обнаружены дубликаты id внутри студии: %. Разрешите их вручную до миграции.', dup;
  end if;
end $$;

-- 1) снимаем FK, которые смотрят на старые PK
alter table bookings drop constraint if exists bookings_service_id_fkey;
alter table bookings drop constraint if exists bookings_specialist_id_fkey;
alter table bookings drop constraint if exists bookings_hall_id_fkey;
alter table services drop constraint if exists services_default_hall_id_fkey;

-- 2) пересобираем PK
alter table specialists drop constraint specialists_pkey;
alter table specialists add primary key (studio_id, id);
alter table halls drop constraint halls_pkey;
alter table halls add primary key (studio_id, id);
alter table services drop constraint services_pkey;
alter table services add primary key (studio_id, id);
alter table addons drop constraint addons_pkey;
alter table addons add primary key (studio_id, id);
alter table portfolio drop constraint portfolio_pkey;
alter table portfolio add primary key (studio_id, id);

-- 3) FK заново — на составной ключ. ON DELETE SET NULL должен гасить только
-- ссылочную колонку, а не studio_id (иначе NOT NULL нарушится).
alter table bookings
  add constraint bookings_service_id_fkey
  foreign key (studio_id, service_id) references services(studio_id, id)
  on delete set null (service_id);
alter table bookings
  add constraint bookings_specialist_id_fkey
  foreign key (studio_id, specialist_id) references specialists(studio_id, id)
  on delete set null (specialist_id);
alter table bookings
  add constraint bookings_hall_id_fkey
  foreign key (studio_id, hall_id) references halls(studio_id, id)
  on delete set null (hall_id);
alter table services
  add constraint services_default_hall_id_fkey
  foreign key (studio_id, default_hall_id) references halls(studio_id, id)
  on delete set null (default_hall_id);

-- B7: подписка на напоминания — per-studio: один браузер может следить
-- за записями в нескольких студиях платформы.
alter table push_subscriptions drop constraint push_subscriptions_endpoint_hash_key;
alter table push_subscriptions add unique (studio_id, endpoint_hash);
