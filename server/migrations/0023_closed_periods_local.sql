-- B-03: закрытые периоды — календарные дни студии, а не UTC-сутки.
-- Старые строки писались как UTC-полночь (00:00Z), новые — как локальная полночь
-- студии, переведённая в UTC. Пересчитываем только старый формат: обе границы
-- ровно UTC-полночь. Для UTC-студий старый и новый формат совпадают, а у не-UTC
-- новые строки UTC-полуночи на границах не имеют — их не трогаем.
update closed_periods cp
set during = tstzrange(
  (lower(cp.during) at time zone 'UTC')::date::timestamp at time zone (s.settings->>'tz'),
  (upper(cp.during) at time zone 'UTC')::date::timestamp at time zone (s.settings->>'tz'),
  '[)'
)
from studios s
where s.id = cp.studio_id
  and (lower(cp.during) at time zone 'UTC')::time = '00:00'
  and (upper(cp.during) at time zone 'UTC')::time = '00:00'
  and coalesce(s.settings->>'tz', 'UTC') <> 'UTC';