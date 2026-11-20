-- B6: промежуточный статус 'processing' (атомарный захват строки воркером)
alter table notify_outbox drop constraint notify_outbox_status_check;
alter table notify_outbox add constraint notify_outbox_status_check
  check (status in ('pending','processing','processed','failed'));
