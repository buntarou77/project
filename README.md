# Платформа записи для фотографов, видеографов и фотостудий

Один код и одна база — много студий. У каждой своя страница `/s/<slug>/`, свой кабинет
владельца, свои иконка и манифест PWA. Клиенту не нужна регистрация: запись по ссылке,
«Моя запись» — по секретному токену на устройстве.

## Запуск без базы (демо, для образцов)

```bash
pnpm install
pnpm dev          # http://localhost:5173
```

Без ключей Supabase включается демо-бэкенд: данные берутся из `tenants/<slug>/tenant.json`,
заявки хранятся в localStorage устройства. Две вымышленные студии уже настроены:
`/s/kadr-studio` (студия: съёмки + аренда) и `/s/anna-vetrova` (фотограф, выезды).
Кабинет: `/owner` (в демо — любой email).

Демо-занятость генерируется детерминированно, чтобы образец всегда показывал и свободные,
и занятые слоты. Код помечен в `src/backend/demo.ts`.

## Команды управления студиями

```bash
pnpm tenant:new --slug=my-studio --name="Студия «Мой»" --city=Москва
pnpm tenant:validate [--slug=…]
pnpm tenant:assets      # фото → public/, манифесты и иконки PWA per-tenant
pnpm build && pnpm preview
pnpm tenant:check --slug=my-studio --url=https://ваш-домен
pnpm tenant:push [--slug=…] [--force]   # заливка в Supabase, см. ниже
```

`tenant:push` по умолчанию **не перезаписывает** существующую студию — правки владельца
защищены. Перезапись первичной заливки только с `--force`.

## Подключение Supabase (реальные данные)

1. Создайте проект (облако или self-hosted на российском сервере — код не меняется,
   все адреса из env).
2. SQL Editor → выполните миграции по порядку: `supabase/migrations/0001_init.sql`,
   затем `supabase/migrations/0002_column_grants.sql` (схема, RLS, exclusion
   constraint, RPC атомарной брони, колоночные права).
3. Создайте владельца: Authentication → Add user (email+пароль), затем в таблице
   `memberships` добавьте строку (`userId` из auth.users, `studioId` = slug студии,
   роль `owner`).
4. `.env`:
   ```
   VITE_SUPABASE_URL=…
   VITE_SUPABASE_ANON_KEY=…
   SUPABASE_SERVICE_ROLE_KEY=…   # только для скриптов/функций, не в бандл
   ```
5. `pnpm tenant:push` — заливка студий из `tenants/`.
6. Edge-функции: `pnpm exec supabase functions deploy availability create-booking
   my-booking assistant ics notify-dispatch` (синхронизация общей логики уже учтена:
   `scripts/sync-shared.ts` копирует `src/core` в `_shared/core` перед деплоем).
7. Переменные функций (`supabase secrets set`): `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
   `OPENAI_MODEL`, `DAILY_MODEL_BUDGET_RUB`, опционально `SMTP_URL`, `OWNER_EMAIL`,
   `VAPID_*`.

## Публикация (Vercel)

```bash
vercel            # обычный SPA: rewrites уже настроены в vercel.json
```

Манифесты и иконки per-tenant генерируются в `prebuild` и отдаются как статика.

## Что где лежит

- `src/core/` — чистая логика: цена, доступность, буферы/дорога/полный день/через полночь.
  Используется клиентом, демо-бэкендом и edge-функциями (копия через sync-shared).
- `src/backend/` — адаптеры: `demo` (localStorage) и `supabase`; выбор по env.
- `supabase/migrations/` — схема + RLS + exclusion constraint + `create_booking_rpc`.
- `supabase/functions/` — availability, create-booking, my-booking, assistant, ics, notify.
- `tenants/<slug>/` — единственный источник первичных настроек студии (Zod-схема).
- `tests/core/` — Vitest; `tests/e2e/` — Playwright.

## Проверено локально

- `pnpm typecheck`, `pnpm test` (30 юнит-тестов), `pnpm build`, `pnpm e2e` (12 тестов:
  chromium + мобильный viewport): запись на съёмку и аренду, явно перечёркнутое занятое
  время, цена до отправки, «Моя запись», галерея/лайтбокс, кабинет (вход, фильтры, CSV,
  календарь, статистика, редакторы услуг/залов/специалистов/доплат/отзывов/закрытых дат,
  переключение студий), tenant:new/validate/assets/push-dry/check.
- Расчёт цены покрыт тестами: тарифы день/вечер/выходные, адонсы (раз/час/человек),
  выезд, предоплата процентом и суммой, переход через полночь.

## Что НЕ проверено (нужен живой Supabase)

- Конкурентная двойная бронь на реальной базе (exclusion constraint в SQL, но гонка
  двух запросов не воспроизводилась).
- Изоляция студий A/B на RLS (тест-кейсы описаны, требуют БД).
- Edge-функции, помощники с моделью, iCal-фид, уведомления (SMTP/push) — код написан,
  исполнение не проверялось.
- Реальная установка PWA на iOS/Android.
- Загрузка референсов клиентов хранит количество и файлы сжимает на устройстве, но
  приватное ведро `references` подключается вместе с Supabase.

## Замены по ТЗ

- **Astryx Design System** недоступна на npm (пустой пакет) → локальные токены
  (`src/ui/styles.css`): темы, акцент владельца, типографика.
- **liquid-gl** существует, но это WebGL-эффекты; для чёткости кнопки использован
  CSS `backdrop-filter` (стекло по ТЗ сохранено).
- MCP Supabase/Vercel, skills `ui-ux-pro-max`/`imagegen` недоступны → CLI + собственные
  SVG-заглушки.
- Шрифты (Playfair Display + Manrope, кириллица) лежат в `public/fonts` и отдаются со
  своего домена; внешних CDN нет.

## Перед приёмом реальных клиентов

- Тексты политики и согласия — черновики: проверьте у юриста (ФЗ-152, локализация).
- Плашка «ОБРАЗЕЦ» и noindex включены при `status: "demo"`; переведите студию в
  `active` после согласия владельца.
- Фото-заглушки — вымышленные; замените на фото владельца с его согласия.
