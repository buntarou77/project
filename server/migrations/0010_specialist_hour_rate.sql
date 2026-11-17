-- Ставка специалиста за час работы (null — не тарифицируется, человек
-- уже входит в пакетную цену). Учитывается в почасовых услугах.
alter table specialists add column if not exists hour_rate integer;
