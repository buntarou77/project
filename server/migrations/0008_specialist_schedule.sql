-- Свой недельный график специалиста (null — работает по графику студии).
alter table specialists add column if not exists schedule jsonb;
