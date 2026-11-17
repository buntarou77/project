-- Фото специалистов: витринный блок «Команда» (включается в настройках студии:
-- settings.teamEnabled). Фото необязательно — специалист без photo_url показывается
-- инициалами. Загрузка — /owner/studios/:slug/specialists/upload.
alter table specialists add column if not exists photo_url text;
