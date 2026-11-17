-- Специалисты услуги: белый список specialist_ids
-- (null/пусто — услугу может брать любой активный специалист).
alter table services add column if not exists specialist_ids jsonb;
