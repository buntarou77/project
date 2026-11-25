-- Закрытые периоды изолированы по студии: PK (studio_id, id) вместо глобального id.
-- Иначе upsert «on conflict (id)» мог перезаписать период другой студии с тем же id
-- (фронт генерирует id как «cp-<миллисекунды>»).
alter table closed_periods drop constraint closed_periods_pkey;
alter table closed_periods add primary key (studio_id, id);
