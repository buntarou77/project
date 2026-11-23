# AGENTS.md — инструкция для агента (ИИ-ассистента) по этому проекту

**Продукт:** мультитенантная SaaS-платформа записи для фотографов, видеографов и
фотостудий. Один код и одна БД обслуживают много студий: витрина `/s/<slug>/`
(клиент бронирует без регистрации), кабинет владельца `/owner` (вход по
email/паролю). Стек: React 18 + TS + Vite (фронт), Express + PostgreSQL (бэк в
`server/`), общее бизнес-ядро `src/core`. Подробности — `PROJECT_OVERVIEW.md`,
план тестирования — `TESTING.md`, настройка — `README.md`.

Среда разработки пользователя: **Fedora 44**, pnpm установлен в
`~/.npm-global/bin` (в новых шеллах: `export PATH="$HOME/.npm-global/bin:$PATH"`).

---

## Команды

| Где | Команда | Что делает |
|---|---|---|
| корень | `pnpm dev` | фронт :5173 (проксирует `/api` → :3000) |
| корень | `pnpm build` / `pnpm preview` | прод-сборка (:4173) |
| корень | `pnpm typecheck` | TS всего фронтенда |
| корень | `pnpm test` | 77 юнит-тестов ядра, demo и формата дат (Vitest) |
| корень | `pnpm e2e` | 18 Playwright-сценариев (демо-режим + новые фичи витрины) |
| корень | `pnpm test:smoke` | 9 API-проверок на живом стеке: сам поднимает тест-студию на :3001, регистрирует владельца, прибирает за собой |
| корень | `pnpm tenant:assets` | генерирует `public/tenants`, `public/s/<slug>` (манифесты, иконки) |
| `server/` | `pnpm dev` | API :3000 с watch |
| `server/` | `pnpm start` | API :3000 **без watch** — после правок сервера рестарт вручную |
| `server/` | `pnpm typecheck` | строгий TS сервера |
| `server/` | `pnpm test:integration` | 48 API-тестов на реальном Postgres (сам поднимает встроенный PG на :5433; или `TEST_DATABASE_URL`) |
| `server/` | `pnpm db:migrate` | применить `server/migrations/*.sql` |
| `server/` | `pnpm cleanup:orphans` | удалить файлы референсов без строки в `booking_references` |
| `server/` | `pnpm studio:create --slug=…` / `studio:invite --slug=…` / `user:reset --email=…` | онбординг студии / ссылка-приглашение / ссылка сброса пароля |
| корень | `node scripts/fetch-fonts.mjs` | перекачать шрифты (кириллица + латиница) в `public/fonts` и `src/ui/fonts.css` |

Проверка перед сдачей работы: `pnpm typecheck` (корень и `server/`), `pnpm test`,
`pnpm test:integration`, `pnpm build`, `pnpm e2e`, `pnpm test:smoke`. Все должны быть зелёными.

---

## Структура (кратко; полное дерево — PROJECT_OVERVIEW.md §3)

- `src/core/` — **чистое бизнес-ядро** без I/O: `price.ts` (цена),
  `availability.ts` (свободные слоты, буферы, полный день, многодневность,
  ночные смены через полночь), `slotGrid.ts`, `time.ts` (таймзоны, UTC-хранение), `schema.ts`
  (Zod-схемы tenant.json и payload заявки). Используется фронтом, демо-адаптером
  и сервером.
- `src/backend/` — интерфейс `Backend` (`types.ts`) + три адаптера: `demo.ts`
  (localStorage, работает без сервера), `supabase.ts` (**легаси, в коде до
  отдельного решения**), `express.ts` (боевой, ходит на `VITE_API_URL` или
  относительные `/api/...`). Выбор — `index.ts` по env.
- `src/studio/`, `src/owner/` — страницы клиента и кабинета.
- `server/src/` — routes (auth, public, owner, team, admin, ical), services
  (bookings, availability, auth, invitations, assistant, notify, ical),
  middleware (auth JWT+cookies, studioAccess с `ROLE_PERMISSIONS`, rateLimit,
  upload — портфолио и референсы), `mapping.ts` (snake_case БД ↔ camelCase API — единственное место).
- `server/migrations/0001_express_init.sql` — базовая схема: 17 таблиц, **EXCLUDE USING
  GIST** на `booking_resources`, RLS не используется (права в middleware).
- `tenants/<slug>/tenant.json` — первичные данные студии (Zod: `src/core/schema.ts`).
- `supabase/` — **легаси** от старого бэкенда. Там не разрабатываем; удаление —
  отдельное решение после боевой проверки Express.

---

## Правила, которые нельзя нарушать

1. **Ядро одно.** Цену/слоты/время считает только `src/core`. Не дублировать эту
   логику ни во фронте, ни на сервере, ни в тестах как «вторую реализацию».
2. **Интерфейс `Backend` — закон.** Типы (`BookingRecord`, `StudioBundle`,
   `CreateBookingPayload`) не менять. Сигнатуры — только согласованные
   добавления (пример: опциональный `ownerStudios?`).
3. **Двойная бронь исключается базой** (EXCLUDE USING GIST на
   `booking_resources`). Никаких проверок пересечения в коде Express как
   «замены». Заявка + блокировки ресурсов пишутся **одной транзакцией**
   (`services/bookings.ts`).
4. **Снапшоты в заявках:** `service_name` и `price` — снимки на момент брони;
   FK `service_id/specialist_id/hall_id` — `ON DELETE SET NULL`.
5. **Секреты — только хеши.** access_token заявки, refresh, приглашения, reset —
   `sha256`; секрет отдаётся клиенту **только один раз** в ответе на создание.
   Токены не хранить в localStorage (auth — HttpOnly cookies).
6. **Статус demo/active студии, slug, calendar_token меняет только
   платформ-админ** (флаг `users.is_platform_admin`). Владелец меняет
   `studios.settings` (PUT /settings валидируется Zod и принудительно ставит
   `status` из колонки).
7. **Роли — константа `ROLE_PERMISSIONS`** в `server/src/middleware/studioAccess.ts`.
   Роли `admin` в memberships НЕ существует. Последний owner не удаляется/не
   понижается (409 `LAST_OWNER`). При удалении участника — отзывать его сессии.
8. **Открытой регистрации нет** — только приглашения (`studio_invitations`,
   хеш токена, одноразовые).
9. **Демо-режим sacred:** без env-переменных всё работает на localStorage;
   e2e-тесты (`tests/e2e/`) не править — их зелёный статус = демо не сломан.
10. **Внешних CDN/шрифтов/аналитики нет.** Шрифты — локальные woff2 в
    `public/fonts` (кириллица ОБЯЗАТЕЛЬНА — был баг с сабсетами, см. «Грабли»).
    Секреты — только в env (`server/.env`, корневой `.env`); в git не попадают.
11. **Миграции только добавлением:** новый файл `server/migrations/NNNN_*.sql`,
    применённые не редактировать.
12. **Форматы:** БД snake_case → API/типы camelCase; время — UTC в базе,
    ms-эпохи в API, показ в таймзоне студии (`settings.tz`) через `src/ui/format`.
13. Скриншоты пользователь прислать не может — баг-репорты приходят текстом по
    шаблону `TESTING.md` §6.0 (шаг, текст с экрана, Response из DevTools, хвост
    лога API).
14. **Ночные смены:** `close < open` — окно принадлежит дню начала и длится до
    утра следующего дня (`windowDurationMin`). Время в БД всегда UTC; в интерфейсе
    подпись «(до следующего дня)». Многодневная почасовая аренда без `fullDay`
    тарифицируется по полным окнам всех дней — поле `hoursPerDay` удалено.
    Референсы клиента грузятся multipart после создания брони (до 5 jpg/png/webp
    по 10 МБ), видны владельцу/менеджеру, стираются при анонимизации;
    анонимизация также сбрасывает `client.referenceCount`.
    Notify: `claimed_at` + 30с timeout доставки + reclaim зависших `processing`
    раз в 5 минут; уборка очередей — только 03:00–05:59 UTC.
15. **Каталог мультиарендный:** допы принадлежат услуге (`services.addonIds`),
    залы/специалисты услуг — белые списки `hallIds`/`specialistIds` (пусто = все
    активные). У допуслуги — свой белый список залов `addons.hallIds` (пусто =
    любой зал; бронь без зала доп с привязкой к залам не получает; фильтрует
    ядро `src/core/price.ts` и форма записи). Аренда (`kind='rental'`) всегда
    занимает зал; съёмка — только при `needsHall`. Услуга со специалистом и без
    зала — всегда выездная (`offsiteRequiredFor`): нужно выбрать зону; без неё
    слотов нет, заявка получает 400. Цена почасовой съёмки без зала = сумма
    ставок всех участников × часы. Услуга-команда — `allSpecialistsRequired` + `specialistIds`: клиент
    никого не выбирает, все участники блокируются, пустой состав — ошибка
    настроек. Удаление зала/специалиста чистит их `booking_resources`; брони
    остаются (FK SET NULL). Ставка специалиста `hour_rate` — только для
    почасовых. Референсы в форме записи —
    `services.referencesEnabled` (undefined = авто: да для услуг со
    специалистом, нет для чистой аренды зала).
16. **Новые булевы настройки** читай как `!== false` (undefined = включено):
    `hallChoiceVisible`, `specialistChoiceVisible`. `teamEnabled`/`reviewsEnabled`
    — наоборот, осознанно off-by-default.
17. **Даты в интерфейсе — по-русски.** Локаль `ru` подключается только в
    `src/ui/format.ts` (`dtInTz`, `humanDate`). В `src/core/time.ts` локаль не
    добавлять: `utcToZonedWeekday` мапит английские `ccc` в `WeekdayKey`.
    Ночное окончание брони показывать через `endInTz` («06:00 след. дня»).

---

## Environment

- Фронт: без env = демо; `VITE_API_URL` = боевой Express (пустое значение в dev —
  vite-прокси `/api` → :3000); `VITE_SUPABASE_*` — переходный легаси.
- Сервер (`server/.env`): `DATABASE_URL`, `PORT=3000`, `JWT_SECRET` (≥32),
  `WEB_ORIGIN`, `PUBLIC_BASE_URL`, `UPLOADS_DIR`, опционально
  `SMTP_URL`+`MAIL_FROM`+`OWNER_EMAIL`, `VAPID_*`, `OPENAI_API_KEY`+
  `OPENAI_BASE_URL`+`OPENAI_MODEL`+`DAILY_MODEL_BUDGET_RUB`.
- Тестовая инфраструктура: `docker-compose.dev.yml` (Postgres :5432 + Mailpit
  :1025/:8025) — **опциональна**: интеграционные тесты сами поднимают
  встроенный Postgres.

---

## Известные грабли (уже отловлены — не наступить)

- **Сеидинг каталога: `create-studio.ts` знает не все колонки** — при добавлении
  полей в specialists/halls/services/addons обновлять и массивы вставки, и
  `columns()` в этом скрипте, иначе новая студия создаётся с потерянными полями.
  Сейчас пробрасываются: schedule/photo_url/show_on_team/hour_rate специалистов,
  photos залов, hall_ids/photo_url/max_people/specialist_ids услуг.
- **Каталог: id — глобальные PK на всю БД** — вторая студия с теми же seed-id
  (`ad-urgent` и т.п.) падает с `_bt_check_unique`; owner-upsert чужого id — тихий
  no-op 204 (`on conflict … where studio_id`). При сидировании второй студии —
  префиксовать id.
- **Новые булевы настройки читаются как `!== false`** — undefined (студия ещё не
  сохраняла настройки) означает «включено». Пример: `hallChoiceVisible`,
  `specialistChoiceVisible` в BookPage. Строгая проверка = баг «всегда выкл».
- **Белый список залов услуги:** пустой `hallIds` (= null/[]) означает «все
  залы». В редакторе услуги — радио «Все залы»/«Только в выбранных», последний
  отмеченный зал снять нельзя, иначе выбор молча превратится во «все».
  Фильтровать нужно и в BookPage (`defaultHallId` мог выпасть из списка), и в
  ручной заявке на сервере.
- **Демо: fullDay-услуги всегда заняты** — псевдозанятость строится по 12 часам
  с modulus 11 (принцип Дирихле): у каждого специалиста каждый день есть блок,
  «весь день» его перекрывает. Бой не задет (блокирует только реальная бронь).
  Не писать e2e «найди свободный fullDay в демо».
- **Добавляешь колонку каталога** — полный цикл: миграция → mapping.ts →
  upsertXxx → `columns()` в create-studio.ts → фронт. Булевы с true-дефолтом —
  читаются `!== false`.
- **Шрифты:** скрипт `scripts/fetch-fonts.mjs` v2 тянет сабсеты cyrillic+latin и
  проверяемо содержит А–Я (проверялось fontTools). Не «оптимизируйте» его без
  этой проверки — старая версия потеряла кириллицу из-за off-by-one в парсинге
  комментариев Google CSS.
- **Отмена клиентом:** секрет заявки не возвращается сервером в теле — фронт
  берёт токен из URL/`bookingStorage` (`MyBookingPage`), не из `b.token`.
- **Refresh single-flight:** параллельные 401 должны проходить ротацию один раз
  (`apiFetch.ts`), иначе пользователь разлогинивается.
- **PUT /settings:** принудительно ставит `status` из колонки studios (владелец
  не может сам снять плашку «ОБРАЗЕЦ»/noindex).
- **Перенос/ре-открытие заявки** пересоздаёт `booking_resources`; закрытие
  (cancelled_by_client/rejected/no_show) — удаляет их. Всё в одной транзакции.
- **Уведомления:** письмо владельцу студии берётся из memberships (не из
  OWNER_EMAIL — он запасной); без SMTP — graceful skip.
- **Мок ИИ:** `pnpm mock:openai` (:3100) для проверки помощника без ключа.
- **Rate limiter fail-open:** сбой БД лимитера не блокирует запросы.
- **Перенос/переезды блокировок при resize** пересчитывают буферы
  setup/cleanup; если сервис удалён — буферы 0.

---

## Стиль работы

- Пользователь тестирует сам по `TESTING.md` §6 и присылает текстовые баг-репорты
  (шаблон §6.0). После каждого фикса: typecheck (корень + server), `pnpm test`,
  `pnpm test:integration`, `pnpm build`, `pnpm e2e` — всё зелёное.
- Комментарии в коде — по-русски, только там, где неочевидно «почему».
- Новые маршруты сервера — по паттерну существующих: `asyncHandler` + ApiHttpError
  + единый формат ошибок `{error:{code,message}}` + rate-limit для публичных.
- Не выдумывать библиотеки: если чего-то нет в package.json — сообщить и
  предложить замену (история: «astryx» оказался пустышкой, liquid-gl заменён на CSS).
