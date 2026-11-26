-- B-65: отдельный токен владения строкой очереди. claimed_at хранит
-- микросекунды, а JS Date/pg теряют их до миллисекунд — условные UPDATE по
-- claimed_at отклоняли собственный claim воркера. lease_id — обычный uuid.
alter table notify_outbox add column lease_id uuid;