-- Фото залов (галерея на витрине) и белый список залов у услуги:
-- hall_ids = null → услуга доступна в любом активном зале;
-- hall_ids = [...] → только перечисленные залы (валидация на сервере).
alter table halls add column if not exists photos jsonb not null default '[]';
alter table services add column if not exists hall_ids jsonb;
