-- 0001_express_init: схема Express-бэкенда (18 таблиц).
-- snake_case в БД; camelCase собирает mapping.ts на сервере.

create extension if not exists btree_gist;
create extension if not exists pgcrypto;
create extension if not exists citext;

-- ===================== АВТОРИЗАЦИЯ =====================

create table users (
  id                uuid primary key default gen_random_uuid(),
  email             citext not null unique,
  password_hash     text not null,
  is_platform_admin boolean not null default false,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table refresh_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  user_agent  text,
  ip_address  inet,
  created_at  timestamptz not null default now()
);
create index refresh_sessions_active on refresh_sessions (user_id)
  where revoked_at is null;

create table password_reset_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);


-- ===================== БИЗНЕСЫ (раньше приглашений: на них ссылаются FK) =====================

create table studios (
  id             text primary key default gen_random_uuid()::text,  -- TEXT: совместимость с tenant.json
  slug           varchar(40) unique not null,
  settings       jsonb not null,                 -- весь TenantSettings, вкл. reviews
  status         text not null default 'demo' check (status in ('demo','active')),
  calendar_token text not null default gen_random_uuid()::text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table memberships (
  user_id    uuid not null references users(id) on delete cascade,
  studio_id  text not null references studios(id) on delete cascade,
  role       text not null check (role in ('owner','manager','employee')),
  created_at timestamptz not null default now(),
  primary key (user_id, studio_id)
);

create table specialists (
  id        text primary key default gen_random_uuid()::text,
  studio_id text not null references studios(id) on delete cascade,
  name      text not null,
  title     text not null default '',
  active    boolean not null default true,
  day_limit int not null default 1
);
create index specialists_studio on specialists (studio_id);

create table halls (
  id        text primary key default gen_random_uuid()::text,
  studio_id text not null references studios(id) on delete cascade,
  name      text not null,
  capacity  int not null default 5,
  rates     jsonb not null,
  active    boolean not null default true
);
create index halls_studio on halls (studio_id);

create table services (
  id               text primary key default gen_random_uuid()::text,
  studio_id        text not null references studios(id) on delete cascade,
  kind             text not null check (kind in ('shoot','rental')),
  name             text not null,
  description      text not null default '',
  price_type       text not null check (price_type in ('fixed','hourly')),
  price            int not null default 0,
  duration_min     int not null default 60,
  includes         jsonb not null default '[]',
  deliverable_text text not null default '',
  deadline_days    int not null default 7,
  prepayment       jsonb not null default '{"type":"percent","value":30}',
  needs_specialist boolean not null default false,
  needs_hall       boolean not null default false,
  default_hall_id  text references halls(id) on delete set null,
  full_day         boolean not null default false,
  multi_day_max    int not null default 1,
  auto_confirm     boolean not null default false,
  setup_min        int not null default 0,
  cleanup_min      int not null default 0,
  sort             int not null default 0
);
create index services_studio_sort on services (studio_id, sort);

create table addons (
  id         text primary key default gen_random_uuid()::text,
  studio_id  text not null references studios(id) on delete cascade,
  applies_to text not null default 'both' check (applies_to in ('shoot','rental','both')),
  name       text not null,
  price      int not null default 0,
  unit       text not null default 'booking' check (unit in ('booking','hour','person')),
  sort       int not null default 0
);
create index addons_studio_sort on addons (studio_id, sort);

create table portfolio (
  id        text primary key default gen_random_uuid()::text,
  studio_id text not null references studios(id) on delete cascade,
  category  text not null default 'портрет',
  caption   text not null default '',
  kind      text not null default 'image' check (kind in ('image','video')),
  video_url text,
  src       text not null,
  srcset    text,
  sort      int not null default 0
);
create index portfolio_studio_sort on portfolio (studio_id, sort);

-- ===================== ПРИГЛАШЕНИЯ =====================

create table studio_invitations (
  id          uuid primary key default gen_random_uuid(),
  studio_id   text not null references studios(id) on delete cascade,
  email       citext,                            -- NULL = приглашение-ссылка
  role        text not null default 'owner'
              check (role in ('owner','manager','employee')),
  token_hash  text not null unique,
  expires_at  timestamptz not null,              -- 7 дней (с email) / 48 часов (без)
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);
create index studio_invitations_pending on studio_invitations (studio_id)
  where accepted_at is null;

-- ===================== БРОНИРОВАНИЯ =====================

create table bookings (
  id                text primary key default gen_random_uuid()::text,
  studio_id         text not null references studios(id) on delete cascade,
  kind              text not null check (kind in ('shoot','rental')),
  service_id        text references services(id) on delete set null,
  service_name      text not null default '',
  specialist_id     text references specialists(id) on delete set null,
  hall_id           text references halls(id) on delete set null,
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  all_day           boolean not null default false,
  day_count         int not null default 1,
  status            text not null default 'new' check (status in
      ('new','confirmed','prepaid','shot_done','processing','delivered',
       'completed','cancelled_by_client','rejected','no_show')),
  client            jsonb not null,
  "references"      jsonb not null default '[]',
  price             jsonb not null default '{"lines":[],"total":0,"prepayment":0}',
  paid_total        numeric not null default 0,
  deliverables_url  text,
  access_token_hash text not null unique,        -- sha256(секрета клиента)
  idempotency_key   text,
  source            text not null default 'web' check (source in ('web','manual')),
  offsite           boolean not null default false,
  travel_zone_id    text,
  consent           jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (studio_id, idempotency_key)
);
create index bookings_studio_status_start on bookings (studio_id, status, starts_at);

create table booking_resources (
  id            text primary key default gen_random_uuid()::text,
  booking_id    text not null references bookings(id) on delete cascade,
  studio_id     text not null references studios(id) on delete cascade,
  resource_type text not null check (resource_type in ('specialist','hall')),
  resource_id   text not null,
  during        tstzrange not null
);
create index booking_resources_lookup on booking_resources
  (studio_id, resource_type, resource_id, during);

alter table booking_resources add constraint booking_resources_no_overlap
  exclude using gist (
    studio_id with =,
    resource_type with =,
    resource_id with =,
    during with &&
  );

create table closed_periods (
  id            text primary key default gen_random_uuid()::text,
  studio_id     text not null references studios(id) on delete cascade,
  resource_type text check (resource_type in ('specialist','hall')),
  resource_id   text,
  during        tstzrange not null,
  reason        text not null default ''
);

-- ===================== СИСТЕМНЫЕ =====================

create table notify_outbox (
  id              text primary key default gen_random_uuid()::text,
  studio_id       text not null references studios(id) on delete cascade,
  booking_id      text references bookings(id) on delete set null,
  channel         text not null,
  payload         jsonb not null default '{}',
  status          text not null default 'pending' check (status in ('pending','processed','failed')),
  attempts        int not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  processed_at    timestamptz,
  created_at      timestamptz not null default now()
);
create index notify_outbox_pending on notify_outbox (status, next_attempt_at);

create table assistant_usage (
  studio_id text not null references studios(id) on delete cascade,
  day       date not null,
  requests  int not null default 0,
  tokens    int not null default 0,
  primary key (studio_id, day)
);

create table rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (key, window_start)
);

create table push_subscriptions (
  id            text primary key default gen_random_uuid()::text,
  studio_id     text not null references studios(id) on delete cascade,
  endpoint_hash text not null unique,
  payload       jsonb not null,
  created_at    timestamptz not null default now()
);

create or replace function increment_rate_limit(p_key text, p_window timestamptz)
returns int language sql as $$
  insert into rate_limits (key, window_start, count) values (p_key, p_window, 1)
  on conflict (key, window_start) do update set count = rate_limits.count + 1
  returning count;
$$;
