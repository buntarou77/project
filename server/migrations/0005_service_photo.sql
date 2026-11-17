-- Обложка услуги (фото в карточке пакета на витрине). Необязательна.
alter table services add column if not exists photo_url text;
