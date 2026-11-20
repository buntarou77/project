-- Просить ли у клиента референсы (до 5 изображений) в форме записи.
-- null = авто: для услуг со специалистом — да, для чистой аренды зала — нет.
alter table services add column if not exists references_enabled boolean;
