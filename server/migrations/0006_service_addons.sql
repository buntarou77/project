-- Допуслуги принадлежат услуге: белый список addon_ids (null — легаси,
-- фильтрация по appliesTo для совместимости со старыми студиями).
alter table services add column if not exists addon_ids jsonb;
