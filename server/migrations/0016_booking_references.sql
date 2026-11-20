-- Y3: референсы клиента — приватные изображения на сервере.
-- Видит только владелец/менеджер через кабинет; анонимизация удаляет файлы.
create table booking_references (
  id          text primary key default gen_random_uuid()::text,
  studio_id   text not null references studios(id) on delete cascade,
  booking_id  text not null references bookings(id) on delete cascade,
  -- физический файл: uploads/<studio_id>/references/<uuid>.jpg
  file_path   text not null,
  mime        text not null check (mime in ('image/jpeg','image/png','image/webp')),
  size_bytes  int not null check (size_bytes > 0 and size_bytes <= 10 * 1024 * 1024),
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
create index booking_references_booking on booking_references (booking_id);
