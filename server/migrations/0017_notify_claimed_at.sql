-- R3: метка захвата строки. Возврат зависших processing → pending
-- периодический (раз в 5 мин), а не только при старте процесса.
alter table notify_outbox add column claimed_at timestamptz;
-- предохранитель: старые строки не имеют метки — reclaim должен их подбирать
update notify_outbox set claimed_at = next_attempt_at where status = 'processing' and claimed_at is null;
