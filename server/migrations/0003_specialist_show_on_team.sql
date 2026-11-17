-- Показ специалиста в блоке «Команда» на витрине отдельно от его активности:
-- active=false — недоступен для записи и скрыт везде; show_on_team=false —
-- записываться можно, но на витрине в команде не светится.
alter table specialists add column if not exists show_on_team boolean not null default true;
