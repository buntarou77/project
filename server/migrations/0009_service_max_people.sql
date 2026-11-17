-- Максимум людей на услугу: жёсткий лимит независимо от вместимости зала
-- (пример: буддийская церемония — не более 2 человек в зале на 8 мест).
alter table services add column if not exists max_people integer;
