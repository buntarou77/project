-- 0001_init: схема платформы. Колонки в camelCase совпадают с доменными типами TS.
-- Id типа text: сохраняют идентификаторы из tenant.json ('sp-anna', 'hall-white').
create extension if not exists btree_gist;
create extension if not exists pgcrypto;

create table if not exists studios (
  "id" text primary key default gen_random_uuid()::text,
  "slug" text unique not null,
  "settings" jsonb not null,
  "status" text not null default 'demo',
  "calendarToken" uuid not null default gen_random_uuid(),
  "createdAt" timestamptz not null default now()
);

create table if not exists memberships (
  "userId" uuid not null references auth.users(id) on delete cascade,
  "studioId" text not null references studios(id) on delete cascade,
  "role" text not null default 'owner',
  primary key ("userId", "studioId")
);

create table if not exists specialists (
  "id" text primary key default gen_random_uuid()::text,
  "studioId" text not null references studios(id) on delete cascade,
  "name" text not null,
  "title" text not null default '',
  "active" boolean not null default true,
  "dayLimit" int not null default 1
);

create table if not exists halls (
  "id" text primary key default gen_random_uuid()::text,
  "studioId" text not null references studios(id) on delete cascade,
  "name" text not null,
  "capacity" int not null default 5,
  "rates" jsonb not null,
  "active" boolean not null default true
);

create table if not exists services (
  "id" text primary key default gen_random_uuid()::text,
  "studioId" text not null references studios(id) on delete cascade,
  "kind" text not null check (kind in ('shoot','rental')),
  "name" text not null,
  "description" text not null default '',
  "priceType" text not null check (priceType in ('fixed','hourly')),
  "price" int not null default 0,
  "durationMin" int not null default 60,
  "includes" jsonb not null default '[]',
  "deliverableText" text not null default '',
  "deadlineDays" int not null default 7,
  "prepayment" jsonb not null default '{"type":"percent","value":30}',
  "needsSpecialist" boolean not null default false,
  "needsHall" boolean not null default false,
  "defaultHallId" text,
  "fullDay" boolean not null default false,
  "multiDayMax" int not null default 1,
  "autoConfirm" boolean not null default false,
  "setupMin" int not null default 0,
  "cleanupMin" int not null default 0,
  "sort" int not null default 0
);

create table if not exists addons (
  "id" text primary key default gen_random_uuid()::text,
  "studioId" text not null references studios(id) on delete cascade,
  "appliesTo" text not null default 'both' check (appliesTo in ('shoot','rental','both')),
  "name" text not null,
  "price" int not null default 0,
  "unit" text not null default 'booking' check (unit in ('booking','hour','person')),
  "sort" int not null default 0
);

create table if not exists portfolio (
  "id" text primary key default gen_random_uuid()::text,
  "studioId" text not null references studios(id) on delete cascade,
  "category" text not null default 'портрет',
  "caption" text not null default '',
  "kind" text not null default 'image' check (kind in ('image','video')),
  "videoUrl" text,
  "src" text not null,
  "srcset" text,
  "sort" int not null default 0
);

create table if not exists reviews (
  "id" text primary key default gen_random_uuid()::text,
  "studioId" text not null references studios(id) on delete cascade,
  "author" text not null,
  "rating" int not null default 5,
  "text" text not null default '',
  "published" boolean not null default true,
  "sort" int not null default 0
);

create table if not exists bookings (
  "id" text primary key default gen_random_uuid()::text,
  "studioId" text not null references studios(id) on delete cascade,
  "slug" text not null,
  "kind" text not null check (kind in ('shoot','rental')),
  "serviceId" text not null,
  "serviceName" text not null default '',
  "specialistId" text,
  "hallId" text,
  "startsAt" timestamptz not null,
  "endsAt" timestamptz not null,
  "allDay" boolean not null default false,
  "dayCount" int not null default 1,
  "status" text not null default 'new',
  "client" jsonb not null,
  "references" jsonb not null default '[]',
  "price" jsonb not null default '{"lines":[],"total":0,"prepayment":0}',
  "paidTotal" numeric not null default 0,
  "deliverablesUrl" text,
  "accessToken" uuid not null default gen_random_uuid() unique,
  "idempotencyKey" text unique,
  "source" text not null default 'web' check (source in ('web','manual')),
  "offsite" boolean not null default false,
  "travelZoneId" text,
  "consent" jsonb not null default '{}',
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists bookings_studio_starts on bookings ("studioId", "startsAt");

-- Неделимая блокировка ресурсов: интервалы брони с буферами.
-- Две брони одного ресурса с пересечением интервалов невозможны на уровне базы.
create table if not exists booking_resources (
  "id" text primary key default gen_random_uuid()::text,
  "bookingId" text not null references bookings(id) on delete cascade,
  "studioId" text not null references studios(id) on delete cascade,
  "resourceType" text not null check (resourceType in ('specialist','hall')),
  "resourceId" text not null,
  "during" tstzrange not null
);
create index if not exists booking_resources_lookup on booking_resources ("studioId", "resourceType", "resourceId", "during");

-- Исключающий.constraint: пересечение интервалов одного ресурса одной студии запрещено.
do $$ begin
  alter table booking_resources add constraint booking_resources_no_overlap
    exclude using gist (
      "studioId" with =,
      "resourceType" with =,
      "resourceId" with =,
      "during" with &&
    );
exception when duplicate_object then null; end $$;

create table if not exists closed_periods (
  "id" text primary key default gen_random_uuid()::text,
  "studioId" text not null references studios(id) on delete cascade,
  "resourceType" text check (resourceType in ('specialist','hall')),
  "resourceId" text,
  "during" tstzrange not null,
  "reason" text not null default ''
);

create table if not exists notify_outbox (
  "id" text primary key default gen_random_uuid()::text,
  "studioId" text not null,
  "bookingId" text,
  "channel" text not null,
  "payload" jsonb not null default '{}',
  "status" text not null default 'pending',
  "createdAt" timestamptz not null default now()
);

create table if not exists assistant_usage (
  "studioId" text not null,
  "day" date not null,
  "requests" int not null default 0,
  "tokens" int not null default 0,
  primary key ("studioId", "day")
);

create table if not exists rate_limits (
  "key" text not null,
  "windowStart" timestamptz not null,
  "count" int not null default 0,
  primary key ("key", "windowStart")
);

-- ===================== RLS =====================
alter table studios enable row level security;
alter table memberships enable row level security;
alter table specialists enable row level security;
alter table halls enable row level security;
alter table services enable row level security;
alter table addons enable row level security;
alter table portfolio enable row level security;
alter table reviews enable row level security;
alter table bookings enable row level security;
alter table booking_resources enable row level security;
alter table closed_periods enable row level security;
alter table notify_outbox enable row level security;
alter table assistant_usage enable row level security;
alter table rate_limits enable row level security;

-- Публичное чтение витринных данных
create policy "public_read_studios" on studios for select using (true);
create policy "public_read_specialists" on specialists for select using (true);
create policy "public_read_halls" on halls for select using (true);
create policy "public_read_services" on services for select using (true);
create policy "public_read_addons" on addons for select using (true);
create policy "public_read_portfolio" on portfolio for select using (true);
create policy "public_read_reviews" on reviews for select using ("published" = true);

-- Владелец: полный доступ к строкам своей студии
create policy "owner_all_memberships" on memberships for all
  using ("userId" = auth.uid()) with check ("userId" = auth.uid());

create policy "owner_rw_studios" on studios for all
  using ("id" in (select "studioId" from memberships where "userId" = auth.uid()))
  with check ("id" in (select "studioId" from memberships where "userId" = auth.uid()));

create policy "owner_rw_specialists" on specialists for all
  using ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()))
  with check ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()));
create policy "owner_rw_halls" on halls for all
  using ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()))
  with check ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()));
create policy "owner_rw_services" on services for all
  using ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()))
  with check ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()));
create policy "owner_rw_addons" on addons for all
  using ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()))
  with check ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()));
create policy "owner_rw_portfolio" on portfolio for all
  using ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()))
  with check ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()));
create policy "owner_rw_reviews" on reviews for all
  using ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()))
  with check ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()));
create policy "owner_rw_bookings" on bookings for all
  using ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()))
  with check ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()));
create policy "owner_rw_booking_resources" on booking_resources for all
  using ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()))
  with check ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()));
create policy "owner_rw_closed" on closed_periods for all
  using ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()))
  with check ("studioId" in (select "studioId" from memberships where "userId" = auth.uid()));

-- bookings, booking_resources, closed_periods, notify_outbox, assistant_usage,
-- rate_limits для анонима недоступны: клиент идёт через серверные функции с service role.

-- ===================== Storage =====================
insert into storage.buckets (id, name, public)
values ('portfolio', 'portfolio', true), ('references', 'references', false)
on conflict (id) do nothing;

create policy "public_read_portfolio_storage" on storage.objects for select
  using (bucket_id = 'portfolio');
create policy "owner_write_portfolio_storage" on storage.objects for insert
  with check (bucket_id = 'portfolio' and auth.role() = 'authenticated');
-- references: приватное ведро, запись/чтение только через service role (edge-функции).

-- ===================== RPC =====================
-- Атомарное создание брони + блокировка ресурсов. Конфликт интервалов
-- на уровне исключающего constraint отклоняет вторую одновременную заявку.
create or replace function create_booking_rpc(p_payload jsonb, p_resources jsonb)
returns jsonb language plpgsql as $$
declare
  v_studio text := p_payload->>'studioId';
  v_token uuid;
  v_existing boolean := false;
  v_id text;
  r record;
begin
  insert into bookings (
    "studioId", "slug", "kind", "serviceId", "serviceName", "specialistId", "hallId",
    "startsAt", "endsAt", "allDay", "dayCount", "status", "client", "price",
    "idempotencyKey", "source", "offsite", "travelZoneId", "consent", "references"
  ) values (
    v_studio,
    p_payload->>'slug',
    p_payload->>'kind',
    p_payload->>'serviceId',
    coalesce(p_payload->>'serviceName', ''),
    nullif(p_payload->>'specialistId', ''),
    nullif(p_payload->>'hallId', ''),
    (p_payload->>'startsAt')::timestamptz,
    (p_payload->>'endsAt')::timestamptz,
    coalesce((p_payload->>'allDay')::boolean, false),
    coalesce((p_payload->>'dayCount')::int, 1),
    coalesce(p_payload->>'status', 'new'),
    p_payload->'client',
    p_payload->'price',
    p_payload->>'idempotencyKey',
    coalesce(p_payload->>'source', 'web'),
    coalesce((p_payload->>'offsite')::boolean, false),
    nullif(p_payload->>'travelZoneId', ''),
    p_payload->'consent',
    coalesce(p_payload->'references', '[]'::jsonb)
  )
  on conflict ("idempotencyKey") do nothing
  returning id, "accessToken" into v_id, v_token;

  if v_token is null then
    select "accessToken" into v_token from bookings where "idempotencyKey" = p_payload->>'idempotencyKey';
    v_existing := true;
  else
    for r in select * from jsonb_array_elements(p_resources) loop
      insert into booking_resources ("bookingId", "studioId", "resourceType", "resourceId", "during")
      values (
        v_id,
        v_studio,
        r.value->>'resourceType',
        r.value->>'resourceId',
        tstzrange((r.value->>'start')::timestamptz, (r.value->>'end')::timestamptz, '[)')
      );
    end loop;
  end if;

  return jsonb_build_object('token', v_token, 'existing', v_existing);
end $$;

create or replace function increment_rate_limit(p_key text, p_window timestamptz)
returns int language sql as $$
  insert into rate_limits ("key", "windowStart", "count") values (p_key, p_window, 1)
  on conflict ("key", "windowStart") do update set "count" = rate_limits."count" + 1
  returning "count";
$$;

create table if not exists push_subscriptions (
  "id" text primary key default gen_random_uuid()::text,
  "studioId" text not null,
  "payload" jsonb not null,
  "createdAt" timestamptz not null default now()
);
alter table push_subscriptions enable row level security;
