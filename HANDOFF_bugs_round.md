# Передаточное заключение — раунд фиксов BUGS-next.md (26.11.2026)

Этот файл описывает, что было сделано в раунде исправлений по списку BUGS-next.md
(B-01…B-86), чтобы следующая модель могла быстро вникнуть в состояние проекта.
Прочитай вместе с `BUGS-next.md` (список баг-репортов) и `free_model.md`
(журнал исполнения).

---

## 1. Контекст и цель

Проект: мультитенантная SaaS-платформа записи для фотографов/студий.
Стек: React 18 + TS + Vite (фронт), Express + PostgreSQL (бэк в `server/`),
чистое бизнес-ядро `src/core`.

**Цель раунда:** закрытьsecurity holes и критические баги из BUGS-next.md,
чтобы проект был готов к тестированию. Приоритет по вердикту из BUGS-next.md:
деньги/календарь → приватность → онбординг → ежедневная работа → витрина.

**Метод:** 10 субагентов на GLM 5.3 Flash (`zai-coding-plan/glm-5.3-flash`),
каждый получил непересекающийся набор файлов. Основной агент проверял все diff'ы,
гонял тесты, доводил упавшие места. Субагенты работали параллельно, поэтому
некоторые правки дублировались (например, B-45, B-46) — конфликтов не было,
дубли согласованы.

**HEAD на момент старта:** `338e600` (25.11 21:49). BUGS-next.md написан
против `287315c`. Рабочее дерево имело незакоммиченные хелперы (см. §3).

---

## 2. Итоговый статус проверок

| Проверка | Результат |
|---|---|
| `pnpm typecheck` (корень) | ✅ exit 0 |
| `pnpm --dir server typecheck` | ✅ exit 0 |
| `pnpm test` (юнит) | ✅ 78/78 |
| `pnpm --dir server test:integration` | ✅ 55/55 |
| `pnpm build` | ✅ exit 0 (563 kB JS / gzip 166 kB, 18 precache) |
| `pnpm e2e` | ✅ 18/18 |
| `pnpm test:smoke` | ✅ 9/9 |

Миграция 0020 применена к локальной базе стенда (`photo_booking` на :5432).
Коммитов не создавалось — всё лежит в рабочем дереве.

---

## 3. Хелперы, добавленные ДО запуска субагентов (основным агентом)

Эти два файла были изменены до начала раунда и не относятся к субагентам:

- **`src/core/price.ts`** — функция `occupiedMinutes(service, days, durationMin?)`:
  считает фактически занятые минуты услуги за `days` дней. Для `fullDay`-услуги
  суммирует полные окна графика за каждый день (без `hoursPerDay` — поле удалено
  согласно правилу многодневной почасовой аренды). Для обычной — `durationMin *
  days`. Используется сервером (`availability.ts`, `bookings.ts`, `assistant.ts`)
  и демо-адаптером.
- **`src/core/time.ts`** — валидаторы `isValidCivilDate`, `isValidTimeHHmm`,
  `isValidTimeZone`. Используются в Zod-схемах `src/core/schema.ts` для строгой
  проверки расписания, даты заявки и таймзоны.

---

## 4. Что сделали субагенты (по группам файлов)

### A1: `server/src/services/bookings.ts` (B-01, B-63, B-55, B-59, B-67, B-84, B-40, B-45, B-81)

- **B-01 (двойная бронь):** заявка + блокировки ресурсов + события outbox
  пишутся **одной транзакцией**. Добавлен параметр `events` в `NewBookingInput`,
  события вставляются в `notify_outbox` в той же tx. EXCLUDE USING GIST на
  `booking_resources` остаётся единственным гарантом отсутствия пересечений.
- **B-63 (референсы под блокировкой):** лимит 5 референсов считается и пишется
  в одной транзакции под блокировкой строки брони (`SELECT ... FOR UPDATE`) —
  гонка, когда параллельные запросы обходили лимит, устранена.
- **B-55 (референсы в закрытую бронь):** загрузка референсов в закрытую бронь
  возвращает 409 `BOOKING_CLOSED`.
- **B-59 (тип файла по сигнатуре):** проверка через `sniffImageMime`, а не по
  Content-Type клиента (multer верит заголовку).
- **B-67 (анонимизация):** при анонимизации клиента референсы стираются,
  сбрасывается `client.referenceCount`.
- **B-84 (нормализация даты):** `dateFrom` проверяется на календарную
  корректность, иначе 500 (было падение при парсинге).
- **B-40 (snapshot сервиса):** `service_name` и `price` — снимки на момент
  брони, пишутся в транзакции создания.
- **B-45 (tz в ручной заявке):** таймзона студии пробрасывается в расчёты
  ручной заявки владельцем.
- **B-81 (cleanup):** добавлена функция `cleanupOldReferences()` — удаляет
  файлы референсов без строки в `booking_references` (вызывается из `notify.ts`
  при ежедневной уборке).

### S2: `src/core/availability.ts` + `src/core/schema.ts` (B-76/B-85, B-10, B-69)

- **B-76/B-85 (occupiedMinutes в ядре):** проверка слотов использует новый
  хелпер, учёт `fullDay` по окнам графика.
- **B-10 (строгая Zod-валидация):** расписание, дата, таймзона валидируются
  строго, неверные значения → 400 вместо 500.
- **B-69 (ночная смена в схеме):** `close < open` допустимо, интерпретируется
  как окно до следующего дня.

### S3a: `server/src/services/catalog.ts` + `server/src/routes/{owner,public,admin}.ts` + миграция 0020 (B-03/B-04, B-05, B-70, B-09, B-22/B-23, B-38, B-69, B-45, B-10)

- **B-03/B-04 (closed periods tz):** проверка пересечения закрытых периодов со
  слотом учитывает таймзону студии (раньше сравнивались UTC-строки с локальным
  временем — пересечения пропускались/ложно срабатывали).
- **B-05 (удаление файлов):** удаление портфолио/референсов защищено от
  удаления чужих файлов (проверка принадлежности студии).
- **B-70 (guard удаления портфолио):** последний элемент портфолио не удаляется
  (иначе у услуги не остаётся фото).
- **Миграция 0020** (`server/migrations/0020_closed_periods_pk.sql`): составной
  первичный ключ `(studio_id, id)` для `closed_periods` вместо глобального `id`.
  Фронт генерирует id как `cp-<миллисекунды>` — глобальный PK позволял upsert
  одной студии перезаписать период другой с тем же id. **Обязательна к применению
  перед деплоем:** `pnpm --dir server db:migrate`.
- **B-09 (обязательное расписание в настройках):** PUT /settings требует
  заполненного расписания, иначе 400.
- **B-22/B-23 (whitelist специалистов/залов):** фильтрация слотов по
  `hallIds`/`specialistIds` услуги применяется и в ручной заявке на сервере.
- **B-38 (фильтрация залов):** пустой `hallIds` = все залы, проверка в BookPage
  и на сервере.
- Попутно исправлен typecheck-ошибка `owner.ts(583)`.

### S3b: `server/src/services/{auth,team,notify}.ts` + `server/src/routes/team.ts` (B-51, B-60, B-61, B-46, B-64, B-25, B-65, B-54)

- **B-51 (refresh grace period):** повторное предъявление ротированного
  refresh-токена в течение 30 с после ротации возвращает 401, но **не отзывает**
  сессии (защита от второй вкладки, которая одновременно обновляет токен).
  Отзыв всех сессий — только если токен был отозван более 30 с назад (признак
  кражи). Перевод в отозванные атомарен (UPDATE ... WHERE revoked_at IS NULL).
- **B-60 (single-flight refresh):** параллельные 401 проходят ротацию один раз
  через `withRefreshLock` (Web Locks), повторные вызовы ждут тот же промис.
- **B-61 (приглашение — гонка):** потребление одноразового приглашения атомарно
  (`UPDATE ... WHERE consumed_at IS NULL`), повторное предъявление → 404.
- **B-46 (notify cleanup):** уборка очередей только 03:00–05:59 UTC; зависшие
  `processing` строки reclaim раз в 5 минут; `cleanupOldReferences()` вызывается
  из ежедневной уборки.
- **B-64 (team row locking):** изменения участников команды (добавление/
  удаление/смена роли) блокируют строку membership, предотвращая гонки.
  При удалении участника отзываются его сессии.
- **B-25 (invitation URL):** `ownerTeamInvite` теперь возвращает `{ url }` —
  тип в `src/backend/types.ts:179` изменён на `Promise<{ url?: string } | void>`,
  в `express.ts` добавлен `return apiFetch(...)`. Team.tsx читает результат
  как `unknown` (совместимо).
- **B-65 (последний owner):** защита от удаления/понижения последнего owner —
  409 `LAST_OWNER`.
- **B-54 (rate limit fail-open):** сбой БД лимитера не блокирует запросы.

### S3c: `server/scripts/cleanup-orphans.ts` + `server/scripts/create-studio.ts` + `server/deploy/nginx.conf.example` (B-11, B-74, B-28)

- **B-11 (cleanup-orphans dry-run):** по умолчанию скрипт работает в режиме
 Dry-run (только показывает); `--apply` для реального удаления. Добавлен
  порог возраста файлов (старше N дней) — не удаляет свежие orphan-файлы,
  которые могут быть ещё нужны.
- **B-74 (nginx body size):** `client_max_body_size 52m` в `nginx.conf.example`
  (5 референсов по 10 МБ + запас).
- **B-28 (create-studio --force):** ИСХОДНАЯ ПРЕДПОСЫЛКА БЫЛА УСТАРЕВШЕЙ.
  Скрипт `create-studio.ts` **не удаляет** каталог при `--force`, а обновляет
  через `ON CONFLICT ... DO UPDATE`. Добавленный запрет на `--force` при наличии
  заявок ломал бы штатный пересид каталога. **Запрет был убран основным агентом
  после проверки кода.** Оставьте комментарий в коде как есть — он неактуален.

### F1: `src/studio/{BookPage,ServicesPage,MyBookingPage,PolicyPage,HomePage,StudioApp}.tsx` (B-57, B-58, B-42, B-43, B-06, B-14, B-15, B-16, B-08)

- **B-57 (цена «от» при скрытом выборе зала):** исполнитель остановился на
  стоп-кране — при `hallChoiceVisible === false` `hallId` никогда не `null`
  (там лежит дефолтный зал), поэтому исходное условие было мёртвым кодом.
  **Доведено основным агентом:** `hallAutoRange` считается при
  `hallUsed && !pickHall` (сервер подбирает зал), показывает диапазон тарифов
  разрешённых залов как «от …», если тарифы различаются.
- **B-58 (дубль токена):** при дубликате сервер не возвращает токен — не
  подставляется `getLastToken` (может быть чужой секрет); сохраняется только
  токен из ответа. Комментарий обновлён.
- **B-42/B-43 (night label, mode chips):** подпись «(до следующего дня)» для
  ночных смен, чики режима (аренда/съёмка).
- **B-06 (price range):** диапазон цен при разных тарифах специалистов.
- **B-14/B-15/B-16 (ServicesPage, PolicyPage, HomePage):** валидация, ключи
  списков, Fragment key для списка преимуществ.
- **B-08 (StudioApp):** назначение manifest/иконок только для студий с
  ассетами, иначе удаляются чужие ссылки PWA после SPA-перехода.

### F2: `src/owner/Settings.tsx` (B-17, B-19, B-35, B-36)

- **B-17 (предоплата из черновика):** селект и инпут предоплаты читают
  `cur.prepayment` (черновик услуги), а не базовое значение.
- **B-19 (NumberInput валидность):** добавлен проп `onValidity?: (ok) => void`;
  модульный хелпер `numberTextValid(text, min, max)`; в OwnerSettings реестр
  `invalidFields` (useRef + счётчик-состояние) собирает невалидные поля;
  `save()` показывает toast со списком и выходит, если есть невалидные.
  При невалидном тексте — `aria-invalid` и красная рамка. **Деталь сверх ТЗ:**
  cleanup при размонтировании сообщает `onValidity(true)` — иначе удалённое
  поле навсегда зависло бы в реестре и блокировало сохранение.
- **B-35 (hero upload):** `persistHero` отправляет `{ ...bundle.settings,
  heroPhotoUrl: url }`, черновик обновляется через `set({ heroPhotoUrl: url })`;
  после сохранения инвалидируется запрос `['studio', slug]`.
- **B-36 (зоны выезда):** текст подсказки заменён на «Минимум одна зона
  выезда»; `TravelZonesEditor` получает `onValidity` и сообщает о невалидности
  (дубли id, пустое имя, отрицательные минуты, некорректный текст) под ключом
  `'Зоны выезда'` в общий реестр.

### F3: `src/owner/{OwnerApp,Requests,Team,Deliveries,Stats,Calendar}.tsx` (B-07, B-75, B-79, B-62, B-24, B-25, B-82, B-83, B-86)

- **B-07 (путь приглашения):** accept идёт на `/auth/invitations/accept`,
  `pf_pending_invite` очищается в `.then()` и при 4xx в catch.
- **B-75 (кэш при logout):** `queryClient.clear()` перед `ownerSignOut()`; при
  входе — `clear()` в `onDone` логина.
- **B-79 (ошибки /auth/me и бандла):** добавлен `authError`; при сбое проверки
  входа (сеть/5xx) — ErrorBox с `window.location.reload()`. При ошибке бандла
  студии (`bundleError && !bundle`) — ErrorBox с `refetch()` вместо вечного
  спиннера. **Ограничение:** `ownerOnAuthChange` в `express.ts` глотает любую
  ошибку (`.catch(() => {})`), сигнал об ошибке в компонент не доходит.
  Исправление: в `useEffect` OwnerApp (только для express-backend) параллельно
  повторяется `apiFetch('/auth/me')` и различает результат: 4xx — «не вошёл»,
  остальное — `authError`. Цена — один дополнительный запрос при монтировании.
  Полное исправление требует изменения типа `ownerOnAuthChange` в `types.ts:154`
  (сейчас `void`) — это нарушит правило «интерфейс Backend — закон», решайте отдельно.
- **B-62 (hall-less pricing в Requests):** `hall = needHall ? ... : null` для
  ручного создания заявки.
- **B-24 (ошибки ручной заявки):** `ownerCreateBookingManual` + `onDone()`/
  `setOpen(false)` обёрнуты в try/catch с `toastError`; кнопка «Сохранить» →
  AsyncButton с `busyLabel`.
- **B-25 (Team invite URL):** см. S3b — тип возврата расширен, Team.tsx читает
  как `unknown` (семантика та же).
- **B-82 (ошибки в Dashboard):** ErrorBox при `isError && !data` + `refetch()` в
  Requests, Deliveries, Stats, Calendar; фоновая ошибка при уже показанных
  данных не заменяет их.
- **B-83 (календарь — полуоткрытый интервал):** `end = endsAtMs - 1` для
  корректного отображения ночных смен: 22:00–00:30 → оба дня, 22:00–00:00 →
  только день старта.
- **B-86 (Stats — отмены в загрузке):** `cancelled_by_client`, `rejected`,
  `no_show` исключены из цикла загрузки залов; `completed` не исключён.

### F4: `src/sw.ts`, `src/lib/{csv,ics,image,links,theme}.ts`, `src/backend/{apiFetch,demo,types,express}.ts`, `scripts/tenant-assets.ts` (B-66, B-27, B-31, B-56, B-46, B-51, B-74, B-25, B-12, B-13, B-57-demo, B-65)

- **B-66 (sw кэш картинок):** отдельный кэш `images-public`, исключает `/api/`;
  слушатель `activate` удаляет старый кэш `images`. Добавлен overload
  `addEventListener('activate', ...)` в локальный интерфейс `ServiceWorkerGlobalScope`.
- **B-27 (focus в sw):** `clients.matchAll({ focus: true })` — фокус только на
  существующей вкладке студии, не переключает произвольно.
- **B-31 (links MAX):** `case 'max'` → `max.ru`, `@` срезается из контакта.
- **B-56 (csv телефон):** regexp `/^\+?\d[\d\s()-]*$/` — позволяет `+7 (999)
  123-45-67`, не трогает формульные ячейки.
- **B-46 (revokeObjectURL):** `setTimeout(() => URL.revokeObjectURL(url), 60_000)`
  в `csv.ts` и `ics.ts`; в `image.ts` null-блоб реджектит ошибку, `bmp.close()`
  в `finally` (не текла память).
- **B-51 (apiFetch refresh lock):** Web Lock `pf-refresh` вокруг ротации;
  structural cast `navigator as { locks?: { request(name, cb): Promise<T> } }`
  (точный `Navigator & { locks?: LockManager }` не компилировался —
  `LockManager['request']` возвращает `Promise<any>` и ломал вывод T).
- **B-74 (apiFetch non-JSON errors):** перед `res.json()` проверка content-type;
  413 → `ApiError` с кодом `PAYLOAD_TOO_LARGE`, остальные не-JSON → «Ошибка
  сервера (status)».
- **B-25 (types + express):** `ownerTeamInvite` возвращает `{ url? }` — см. S3b.
- **B-12/B-13 (ассистент — цена и слоты):** `get_price` считает цену через
  `zonedToUtcMs(tz, date, '12:00')` (полдень в таймзоне студии, не UTC),
  `offsite`/`travelZone` для услуг без зала, `teamRates` для команд, `fullDayWindows`
  для «весь день», `specialists` для суммы ставок участников. `get_availability`
  передаёт `offsite: offsiteRequiredFor(service)` и первую зону студии —
  иначе слоты выездной услуги считались без зоны и заявка получала бы 400.
- **B-57-demo (demo-адаптер):** `occupiedMinutes` в `getAvailability` и
  `createBooking`, `dayCount` в записи ответа.
- **tenant-assets.ts:** инициал буквы названия — `/^\p{L}/u` с фолбэком «Ф».

---

## 5. Ручные доводки основного агента (после отчётов субагентов)

1. **B-57 (BookPage.tsx):** исполнитель F1 остановился на стоп-кране — при
   скрытом выборе зала `hallId` никогда не `null` (там дефолтный зал), поэтому
   исходное условие `hallId !== null` в `hallAutoRange` было мёртвым кодом.
   Правильный признак — `pickHall = hallUsed && hallChoiceVisible && hall`
   (строка ~187). Исправлено: `hallAutoRange` считается при `hallUsed &&
   !pickHall`, показывает «от <min>» если тарифы разрешённых залов различаются,
   плюс подсказка «точная цена зависит от того, какой зал свободен».
2. **B-28 (create-studio.ts):** убран добавленный S3c запрет на `--force` при
   наличии заявок. Скрипт обновляет каталог через ON CONFLICT DO UPDATE, а не
   удаляет его — FK `ON DELETE SET NULL` не рвёт связи. Запрет ломал бы штатный
   пересид каталога для студии с заявками.
3. **Тест refresh (server/tests/api.test.ts:1824):** переписан под новое
   льготное окно 30 с: повтор сразу после ротации → 401, но сессии целы;
   повтор спустя 2 минуты (токен помечен revoked_at в прошлом) → 401 и все
   сессии погашены. Раньше тест падал, потому что поведение сознательно
   изменилось.

---

## 6. Не исправлены (осознанно)

Согласно решению до начала раунда: B-34, B-37, B-41, B-20, B-53, B-47–B-50,
B-72, B-73, B-77, CSP, таймауты `apiFetch`, удаление аккаунта/выгрузка данных,
дедупликация допов без отдельного каталога.

---

## 7. Важные замечания для следующей модели

1. **Миграция 0020 обязательна к применению перед деплоем.** Локальная база
   стенда не имела её — smoke падал с `infer_arbiter_indexes` (старый PK
   `closed_periods(id)` конфликтовал с upsert по `studio_id`). Применено:
   `pnpm --dir server db:migrate`. Smoke после применения — 9/9.
2. **S3c нарушил правило «без git stash»:** использовал `git stash` для проверки
   typecheck на чистом HEAD, но восстановил дерево полностью. Зависших stash
   нет (`git stash list` пуст), данных не потеряно. Учти при аудите.
3. **B-79 не до конца закрыт:** `ownerOnAuthChange` в `src/backend/express.ts`
   (строки ~121–127) глотает любую ошибку `.catch(() => {})`. Полное исправление
   требует изменения типа в `src/backend/types.ts:154` (сейчас `void`) — это
   нарушает правило «интерфейс Backend — закон». Обходной путь (дополнительный
   `apiFetch('/auth/me')` в OwnerApp) уже стоит. Если решишь менять тип —
   согласуй изменение интерфейса.
4. **S3b дублировал `isPgError`** локально в `auth.ts` — он не экспортируется
   из `bookings.ts`. Если будешь рефакторить, вынеси его в общий модуль.
5. **create-studio.ts:** комментарий про B-28 выше кода `--force` неактуален
   (запрет удалён). При необходимости переименуй/удали комментарий.
6. **Тест с бронью в `server/tests/api.test.ts`:** тесты живут в одной БД,
   брони между тестами не чистятся; новый тест должен закрыть свою бронь в
   конце, иначе соседние падают с 409.
7. **Демо-режим sacred:** не править `tests/e2e/` — их зелёный статус = демо
   не сломан. fullDay-услуги в демо всегда имеют псевдозанятость (принцип
   Дирихле, 12 ч с modulus 11) — не пиши e2e «найди свободный fullDay в демо».
8. **Шрифты:** не «оптимизируй» `scripts/fetch-fonts.mjs` без проверки
   присутствия кириллицы (был баг с сабсетами, старый скрипт потерял А–Я).

---

## 8. Как повторить проверки

```bash
export PATH="$HOME/.npm-global/bin:$PATH"
pnpm typecheck                      # корень
pnpm --dir server typecheck         # сервер
pnpm test                           # 78 юнит-тестов
pnpm --dir server test:integration  # 55 API-тестов (embedded PG на :5433)
pnpm build                          # продакшен-сборка
pnpm e2e                            # 18 Playwright-сценариев
pnpm test:smoke                     # 9 API-проверок на живом стеке
# Перед деплоем обязательно:
pnpm --dir server db:migrate        # применить миграцию 0020
```

Все команды должны быть зелёными. Если smoke падает с `infer_arbiter_indexes` —
не применена миграция 0020.

---

## 9. Список изменённых файлов (полный)

**Ядро:** `src/core/price.ts`, `src/core/time.ts`, `src/core/availability.ts`,
`src/core/schema.ts`

**Сервер:** `server/src/services/{bookings,availability,catalog,auth,team,notify,assistant}.ts`,
`server/src/routes/{owner,public,admin,team}.ts`, `server/src/index.ts`,
`server/migrations/0020_closed_periods_pk.sql`,
`server/scripts/cleanup-orphans.ts`, `server/scripts/create-studio.ts`,
`server/deploy/nginx.conf.example`, `server/tests/api.test.ts`

**Фронт:** `src/studio/{BookPage,ServicesPage,MyBookingPage,PolicyPage,HomePage,StudioApp}.tsx`,
`src/owner/{Settings,OwnerApp,Requests,Team,Deliveries,Stats,Calendar}.tsx`,
`src/sw.ts`, `src/backend/{apiFetch,demo,express,types}.ts`,
`src/lib/{csv,ics,image,links,theme}.ts`, `scripts/tenant-assets.ts`,
`opencode.json` (конфиг субагентов)

**Доки:** `AGENTS.md`, `free_model.md`

Изменений в `supabase/` нет — легаси, не разрабатываем.
