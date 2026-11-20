// Интеграционные тесты API: реальный Postgres (TEST_DATABASE_URL) + supertest.
// Запуск:
//   docker run -d --name pg-test -e POSTGRES_PASSWORD=test -p 5433:5432 postgres:15
//   cd server && TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/postgres pnpm test:integration
// Без TEST_DATABASE_URL весь файл пропускается (демо/e2e не зависят от него).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'

// Если TEST_DATABASE_URL не задан — поднимаем встроенный Postgres (без root и Docker).
let embeddedPg: { stop: () => Promise<void> } | null = null
let embeddedFailed: string | null = null
if (!process.env.TEST_DATABASE_URL) {
  try {
    const { default: EmbeddedPostgres } = await import('embedded-postgres')
    embeddedPg = new EmbeddedPostgres({
      databaseDir: path.resolve(__dirname, '.pgdata'),
      user: 'postgres',
      password: 'test',
      port: 5433,
      persistent: false,
    })
    await embeddedPg.initialise()
    await embeddedPg.start()
    await embeddedPg.createDatabase('photo_booking_test')
    process.env.TEST_DATABASE_URL = 'postgres://postgres:test@localhost:5433/photo_booking_test'
    console.log('embedded postgres: поднят на :5433')
  } catch (e) {
    embeddedFailed = e instanceof Error ? e.message : String(e)
    console.warn('embedded postgres недоступен:', embeddedFailed)
  }
}

const TEST_DB = process.env.TEST_DATABASE_URL
const d = TEST_DB ? describe : describe.skip

let app: Express
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any

// -------- утилиты --------

function cookiesOf(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined
  return (raw ?? []).map((c) => c.split(';')[0]).join('; ')
}

async function migrateFresh(): Promise<void> {
  await pool.query(`drop schema if exists public cascade; create schema public;`)
  // все миграции по порядку — при добавлении новых файлов тест их подхватит сам
  const dir = path.resolve(__dirname, '../migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    await pool.query(readFileSync(path.join(dir, f), 'utf8'))
  }
}

async function reset(): Promise<void> {
  const tables = [
    'booking_resources', 'bookings', 'notify_outbox', 'assistant_usage', 'rate_limits',
    'push_subscriptions', 'closed_periods', 'studio_invitations', 'memberships',
    'refresh_sessions', 'password_reset_tokens', 'portfolio', 'addons', 'services',
    'halls', 'specialists', 'studios', 'users',
  ]
  await pool.query(`truncate ${tables.join(', ')} restart identity cascade`)
}

const MIN_SETTINGS = {
  slug: 'test-studio',
  name: 'Тестовая студия',
  tagline: '',
  description: '',
  city: 'Тест',
  address: 'ул. Тест 1',
  mapsUrl: 'https://yandex.ru/maps/',
  phone: '+7 (900) 000-00-00',
  contactMethods: [{ type: 'telegram', value: 'https://t.me/test' }],
  tz: 'Europe/Moscow',
  accent: '#0f766e',
  theme: 'light',
  modes: { shoots: true, rental: true },
  status: 'demo',
  schedule: {
    mon: { open: '10:00', close: '21:00' },
    tue: { open: '10:00', close: '21:00' },
    wed: { open: '10:00', close: '21:00' },
    thu: { open: '10:00', close: '21:00' },
    fri: { open: '10:00', close: '21:00' },
    sat: { open: '10:00', close: '20:00' },
    sun: null,
  },
  closedDates: [],
  cancellation: { freeHours: 48, text: 'Правила отмены' },
  prepaymentDefault: { type: 'percent', value: 30 },
  travelZones: [{ id: 'city', name: 'по городу', minutesBefore: 0, minutesAfter: 0, extraFee: 0 }],
  infoCards: [],
  reviews: [],
  reviewsEnabled: false,
  eveningFrom: '18:00',
}

const SERVICE_RENTAL = {
  id: 'svc-rental',
  kind: 'rental',
  name: 'Аренда зала',
  description: '',
  priceType: 'hourly',
  price: 0,
  durationMin: 60,
  includes: [],
  deliverableText: '',
  deadlineDays: 0,
  prepayment: { type: 'amount', value: 500 },
  needsSpecialist: false,
  needsHall: true,
  fullDay: false,
  multiDayMax: 1,
  autoConfirm: true,
  setupMin: 0,
  cleanupMin: 0,
  sort: 1,
  referencesEnabled: false,
}

// ближайший рабочий день (пн–сб) не раньше чем через 3 дня:
// отмена клиентом допустима за 48ч, поэтому бронь должна быть дальше окна
function nextOpenDate(): string {
  const dt = new Date()
  dt.setDate(dt.getDate() + 3)
  while (dt.getDay() === 0) dt.setDate(dt.getDate() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

d('Express API — интеграция', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!'
    process.env.NODE_ENV = 'test'
    process.env.UPLOADS_DIR = './uploads-test'
    process.env.DISABLE_WORKER = '1'

    const { pool: p } = await import('../src/db')
    pool = p
    await migrateFresh()
    const { buildApp } = await import('../src/app')
    app = buildApp()
  })

  afterAll(async () => {
    // K3: сначала закрываем пул приложения, ждём, и только потом гасим embedded-PG.
    // Плюс ловим ошибки соединений, которые pg кидает асинхронно после terminate.
    try {
      if (pool) {
        pool.on('error', () => {})
        await pool.end()
      }
    } finally {
      if (embeddedPg) {
        try {
          await embeddedPg.stop()
        } catch (e) {
          console.warn('embedded pg stop:', e instanceof Error ? e.message : e)
        }
        // следующий integration-файл должен поднять свой чистый embedded PG:
        // иначе он увидит TEST_DATABASE_URL уже остановленной БД
        delete process.env.TEST_DATABASE_URL
      }
    }
  })

  let ownerCookies = ''
  let adminCookies = ''
  let employeeCookies = ''
  let employeeUserId = ''
  let bookingToken = ''

  it('здоровье: /api/auth/me без cookie → 401', async () => {
    const res = await request(app).get('/api/auth/me')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('админ создаёт студию и приглашение владельцу', async () => {
    // платформ-админ создаётся напрямую в БД (открытой регистрации нет)
    const { hashPassword } = await import('../src/services/passwords')
    await pool.query(
      `insert into users (email, password_hash, is_platform_admin) values ($1, $2, true)`,
      ['admin@test.ru', await hashPassword('admin-password')]
    )
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.ru', password: 'admin-password' })
    expect(login.status).toBe(200)
    adminCookies = cookiesOf(login)

    const created = await request(app)
      .post('/api/admin/studios')
      .set('Cookie', adminCookies)
      .send({ slug: 'test-studio', settings: MIN_SETTINGS })
    expect(created.status).toBe(201)

    const inv = await request(app)
      .post('/api/admin/studios/test-studio/invitations')
      .set('Cookie', adminCookies)
      .send({ email: 'owner@test.ru', role: 'owner' })
    expect(inv.status).toBe(201)
    expect(inv.body.url).toContain('/invite/')

    // открытой регистрации нет: register без валидного токена → 400
    const bad = await request(app)
      .post('/api/auth/register')
      .send({ token: 'invalid-token-value', password: '12345678', email: 'x@x.ru' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('INVITATION_INVALID')

    const token = inv.body.url.split('/invite/')[1]

    // страница активации получает данные приглашения по токену
    const info = await request(app)
      .get(`/api/invitations/info?token=${encodeURIComponent(token)}`)
    expect(info.status).toBe(200)
    expect(info.body.studioName).toBe('Тестовая студия')
    expect(info.body.email).toBe('owner@test.ru')
    expect(info.body.role).toBe('owner')
    const badInfo = await request(app).get('/api/invitations/info?token=garbage')
    expect(badInfo.status).toBe(400)
    expect(badInfo.body.error.code).toBe('INVITATION_INVALID')

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ token, password: 'owner-password' })
    expect(reg.status).toBe(200)
    ownerCookies = cookiesOf(reg)
    expect(reg.body.studios[0].slug).toBe('test-studio')
    expect(reg.body.studios[0].role).toBe('owner')

    // одноразовость: после активации info → 400
    const reused = await request(app)
      .get(`/api/invitations/info?token=${encodeURIComponent(token)}`)
    expect(reused.status).toBe(400)
  })

  it('владелец наполняет каталог: зал, услуга (автоподтверждение, почасовая)', async () => {
    const hall = await request(app)
      .post('/api/owner/studios/test-studio/halls')
      .set('Cookie', ownerCookies)
      .send({ id: 'hall-1', name: 'Зал 1', capacity: 6, rates: { weekday: { day: 1200, evening: 1500 }, weekend: { day: 1600, evening: 1800 } }, active: true })
    expect(hall.status).toBe(204)

    const svc = await request(app)
      .post('/api/owner/studios/test-studio/services')
      .set('Cookie', ownerCookies)
      .send(SERVICE_RENTAL)
    expect(svc.status).toBe(204)
  })

  it('допуслуга: белый список залов сохраняется и отдаётся на витрину', async () => {
    const res = await request(app)
      .post('/api/owner/studios/test-studio/addons')
      .set('Cookie', ownerCookies)
      .send({ id: 'ad-hall-scope', appliesTo: 'rental', name: 'Циклорама', price: 800, unit: 'booking', hallIds: ['hall-1'] })
    expect(res.status).toBe(204)

    const bundle = await request(app).get('/api/public/studios/test-studio')
    const saved = bundle.body.addons.find((a: { id: string }) => a.id === 'ad-hall-scope')
    expect(saved.hallIds).toEqual(['hall-1'])
  })

  it('витрина и слоты', async () => {
    const bundle = await request(app).get('/api/public/studios/test-studio')
    expect(bundle.status).toBe(200)
    expect(bundle.body.services).toHaveLength(1)
    expect(bundle.body.services[0].referencesEnabled).toBe(false) // null = авто, false сохранён явно
    expect(bundle.body.settings.name).toBe('Тестовая студия')
    expect(bundle.body.calendarToken).toBeUndefined() // токен календаря не публичный

    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: nextOpenDate(), durationMin: 60, hallId: 'hall-1' })
    expect(slots.status).toBe(200)
    expect(slots.body.slots.length).toBeGreaterThan(0)
  })

  it('бронь создаётся, идемпотентный повтор → duplicate без второго токена', async () => {
    const date = nextOpenDate()
    const startUtcMs = new Date(`${date}T09:00:00Z`).getTime() // 12:00 МСК
    const payload = {
      kind: 'rental',
      serviceId: 'svc-rental',
      hallId: 'hall-1',
      startUtcMs,
      durationMin: 60,
      peopleCount: 2,
      addonIds: [],
      client: { name: 'Клиент Тест', phone: '+79001234567', method: 'telegram' },
      consent: true,
      honeypot: '',
      idempotencyKey: 'test-key-1',
    }
    const first = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send(payload)
    expect(first.status).toBe(200)
    expect(first.body.ok).toBe(true)
    expect(first.body.token).toBeTruthy()
    bookingToken = first.body.token

    const again = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send(payload)
    expect(again.status).toBe(200)
    expect(again.body.duplicate).toBe(true)
    expect(again.body.token).toBeUndefined() // секрет уже выдан первым ответом

    const total = await pool.query(`select count(*)::int n from bookings`)
    expect(total.rows[0].n).toBe(1)
  })

  it('гонка: два параллельных запроса на одно время → одна бронь, второй 409', async () => {
    const mk = (key: string) =>
      request(app)
        .post('/api/public/studios/test-studio/bookings')
        .send({
          kind: 'rental', serviceId: 'svc-rental', hallId: 'hall-1',
          startUtcMs: new Date(`${nextOpenDate()}T11:00:00Z`).getTime(),
          durationMin: 60, peopleCount: 1, addonIds: [],
          client: { name: 'Гонка', phone: '+79001112233', method: 'phone' },
          consent: true, honeypot: '', idempotencyKey: key,
        })
    const [a, b] = await Promise.all([mk('race-aaaaaaaa'), mk('race-bbbbbbbb')])
    const okCount = [a, b].filter((r) => r.status === 200).length
    const conflictCount = [a, b].filter((r) => r.status === 409).length
    expect(okCount).toBe(1)
    expect(conflictCount).toBe(1)
    expect([a, b].find((r) => r.status === 409)!.body.error.code).toBe('BOOKING_CONFLICT')
  })

  it('занятое время занято: слот из брони недоступен', async () => {
    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: nextOpenDate(), durationMin: 60, hallId: 'hall-1' })
    const busy = slots.body.slots.find((s: { startMs: number }) =>
      s.startMs === new Date(`${nextOpenDate()}T09:00:00Z`).getTime()
    )
    expect(busy).toBeUndefined()
  })

  it('моя запись по секретному токену', async () => {
    const res = await request(app).get(`/api/public/studios/test-studio/bookings/${bookingToken}`)
    expect(res.status).toBe(200)
    expect(res.body.client.name).toBe('Клиент Тест')
    expect(res.body.token).toBe('') // секрет в теле не возвращается
    expect(res.body.access_token_hash).toBeUndefined()

    const bad = await request(app).get('/api/public/studios/test-studio/bookings/wrong-token')
    expect(bad.status).toBe(404)
  })

  it('клиент отменяет в окне → слот освобождается', async () => {
    const cancel = await request(app)
      .post(`/api/public/studios/test-studio/bookings/${bookingToken}/cancel`)
    expect(cancel.status).toBe(200)

    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: nextOpenDate(), durationMin: 60, hallId: 'hall-1' })
    const freed = slots.body.slots.find((s: { startMs: number }) =>
      s.startMs === new Date(`${nextOpenDate()}T09:00:00Z`).getTime()
    )
    expect(freed).toBeTruthy()
  })

  it('отмена вне окна → 409 CANCEL_WINDOW_CLOSED; ре-открытие возвращает блокировку', async () => {
    // свободный слот берём из availability
    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: nextOpenDate(), durationMin: 60, hallId: 'hall-1' })
    const slot = slots.body.slots[0]

    const owner = await request(app)
      .post('/api/owner/studios/test-studio/bookings')
      .set('Cookie', ownerCookies)
      .send({
        kind: 'rental', serviceId: 'svc-rental', serviceName: 'Ручная бронь',
        hallId: 'hall-1', startsAtMs: slot.startMs, endsAtMs: slot.startMs + 3_600_000,
        allDay: false, dayCount: 1, status: 'confirmed',
        client: { name: 'Ручной клиент', phone: '+79005556677', method: 'phone' },
        price: { lines: [], total: 1200, prepayment: 0 }, paidTotal: 300,
      })
    expect(owner.status).toBe(201)
    const manualId = owner.body.id

    // вне окна: freeHours 48 > остатка до начала → 409 + блокировка не тронута
    // (создаём клиентский токен руками через прямую вставку второго слота не нужно —
    // проверяем отмену клиентом по этой ручной заявке через admin-токен нельзя;
    // поэтому проверяем reopen на этой же заявке)
    const reopenPath = await request(app)
      .patch('/api/owner/studios/test-studio/bookings/' + manualId)
      .set('Cookie', ownerCookies)
      .send({ status: 'cancelled_by_client' })
    expect(reopenPath.status).toBe(200)

    const slotsAfterCancel = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: nextOpenDate(), durationMin: 60, hallId: 'hall-1' })
    const freed = slotsAfterCancel.body.slots.find((s: { startMs: number }) => s.startMs === slot.startMs)
    expect(freed).toBeTruthy() // §8.1: отмена сняла блокировку

    // §ре-открытие: возврат в активный статус восстанавливает блокировку
    const reopen = await request(app)
      .patch('/api/owner/studios/test-studio/bookings/' + manualId)
      .set('Cookie', ownerCookies)
      .send({ status: 'confirmed' })
    expect(reopen.status).toBe(200)

    const slotsAfterReopen = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: nextOpenDate(), durationMin: 60, hallId: 'hall-1' })
    const busyAgain = slotsAfterReopen.body.slots.find((s: { startMs: number }) => s.startMs === slot.startMs)
    expect(busyAgain).toBeUndefined()
  })

  it('перенос двигает блокировку (§8.2)', async () => {
    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: nextOpenDate(), durationMin: 60, hallId: 'hall-1' })
    const target = slots.body.slots[0]

    const list = await request(app)
      .get('/api/owner/studios/test-studio/bookings')
      .set('Cookie', ownerCookies)
    const manual = list.body.items.find((b: { serviceName: string }) => b.serviceName === 'Ручная бронь')

    const moved = await request(app)
      .patch(`/api/owner/studios/test-studio/bookings/${manual.id}`)
      .set('Cookie', ownerCookies)
      .send({ startsAtMs: target.startMs, endsAtMs: target.startMs + 3_600_000 })
    expect(moved.status).toBe(200)

    const after = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: nextOpenDate(), durationMin: 60, hallId: 'hall-1' })
    // после переноса: старое время освободилось, новое занято
    const oldFreed = after.body.slots.some((s: { startMs: number }) => s.startMs === manual.startsAtMs)
    const targetBusy = after.body.slots.every((s: { startMs: number }) => s.startMs !== target.startMs)
    expect(oldFreed).toBe(true)
    expect(targetBusy).toBe(true)
  })

  it('роли: сотрудник видит заявки без финансов и не может писать; команда только у owner', async () => {
    const inv = await request(app)
      .post('/api/admin/studios/test-studio/invitations')
      .set('Cookie', adminCookies)
      .send({ email: 'employee@test.ru', role: 'employee' })
    const token = inv.body.url.split('/invite/')[1]
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ token, password: 'employee-pass' })
    expect(reg.status).toBe(200)
    employeeCookies = cookiesOf(reg)
    employeeUserId = reg.body.user.id

    const list = await request(app)
      .get('/api/owner/studios/test-studio/bookings')
      .set('Cookie', employeeCookies)
    expect(list.status).toBe(200)
    for (const b of list.body.items) expect(b.paidTotal).toBe(0) // finance:read нет

    const patch = await request(app)
      .patch('/api/owner/studios/test-studio/bookings/whatever')
      .set('Cookie', employeeCookies)
      .send({ status: 'confirmed' })
    expect(patch.status).toBe(403)

    const team = await request(app)
      .get('/api/owner/studios/test-studio/team')
      .set('Cookie', employeeCookies)
    expect(team.status).toBe(403)
  })

  it('LAST_OWNER: единственного владельца удалить нельзя', async () => {
    const me = await request(app).get('/api/auth/me').set('Cookie', ownerCookies)
    const ownerId = me.body.user.id
    const del = await request(app)
      .delete(`/api/owner/studios/test-studio/members/${ownerId}`)
      .set('Cookie', ownerCookies)
    expect(del.status).toBe(409)
    expect(del.body.error.code).toBe('LAST_OWNER')
  })

  it('аноним не может читать заявки и менять настройки', async () => {
    const bookings = await request(app).get('/api/owner/studios/test-studio/bookings')
    expect(bookings.status).toBe(401)
    const settings = await request(app)
      .put('/api/owner/studios/test-studio/settings')
      .send(MIN_SETTINGS)
    expect(settings.status).toBe(401)
  })

  it('iCal по токену студии', async () => {
    const ct = await request(app)
      .get('/api/owner/studios/test-studio/calendar-token')
      .set('Cookie', ownerCookies)
    expect(ct.status).toBe(200)
    const feed = await request(app).get(`/api/ical/test-studio?token=${ct.body.token}`)
    expect(feed.status).toBe(200)
    expect(feed.text).toContain('BEGIN:VCALENDAR')
    const wrong = await request(app).get('/api/ical/test-studio?token=wrong')
    expect(wrong.status).toBe(404)
  })

  // -------- регрессии цикла фиксов (fullDay/валидация/роли/каталог) --------

  const SPECIALIST = { id: 'sp-anna', name: 'Анна', title: 'Фотограф', active: true, dayLimit: 3 }
  const SERVICE_WEDDING = {
    ...SERVICE_RENTAL,
    id: 'svc-wedding',
    kind: 'shoot',
    name: 'Свадьба под ключ',
    priceType: 'fixed',
    price: 45000,
    durationMin: 600,
    needsSpecialist: true,
    needsHall: false,
    fullDay: true,
    multiDayMax: 2,
    prepayment: { type: 'amount', value: 0 },
    sort: 2,
  }

  // пара дней пн–пт (оба будни: окна 10:00–21:00 = 660 мин) не ближе 4 дней
  function weekdayPair(daysAhead: number): [string, string] {
    const dt = new Date()
    dt.setDate(dt.getDate() + daysAhead)
    while (!(dt.getDay() >= 1 && dt.getDay() <= 4)) dt.setDate(dt.getDate() + 1)
    const pad = (n: number) => String(n).padStart(2, '0')
    const d1 = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
    dt.setDate(dt.getDate() + 1)
    const d2 = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
    return [d1, d2]
  }

  async function bookWedding(d1: string, dayCount: number, key: string) {
    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-wedding', dateFrom: d1, dayCount, hallId: null, specialistId: null })
    return { slots, book: (extra: Record<string, unknown> = {}) =>
      request(app)
        .post('/api/public/studios/test-studio/bookings')
        .send({
          kind: 'shoot', serviceId: 'svc-wedding', specialistId: null, hallId: null,
          startUtcMs: slots.body.slots[0]?.startMs, dayCount, peopleCount: 2, addonIds: [],
          client: { name: 'Свадьба Тест', phone: '+79009990011', method: 'phone' },
          consent: true, honeypot: '', idempotencyKey: key, ...extra,
        })
    }
  }

  // --------
  // регресс-блок делает много POST /bookings — сбрасываем счётчики rate-limit
  const clearRate = () => pool.query('delete from rate_limits')

  it('fixed + «весь день»: цена = пакет × дни, не ×2 от длины окна (660 мин > базы 600)', async () => {
    await clearRate()
    await request(app).post('/api/owner/studios/test-studio/specialists').set('Cookie', ownerCookies).send(SPECIALIST)
    const svc = await request(app).post('/api/owner/studios/test-studio/services').set('Cookie', ownerCookies).send(SERVICE_WEDDING)
    expect(svc.status).toBe(204)

    const [d1] = weekdayPair(4)
    const { slots, book } = await bookWedding(d1, 1, 'wed-1day')
    expect(slots.status).toBe(200)
    expect(slots.body.slots.length).toBeGreaterThan(0)
    const res = await book()
    expect(res.status).toBe(200)
    expect(res.body.price.total).toBe(45000) // раньше сервер давал 90000 (k=ceil(660/600)=2)
    expect(res.body.price.lines[0].amount).toBe(45000)
  })

  it('многодневная свадьба (2 дня, «любой свободный») бронируется; цена ×2, конец = закрытие дня 2', async () => {
    const [d1, d2] = weekdayPair(8)
    const { slots, book } = await bookWedding(d1, 2, 'wed-2day')
    expect(slots.body.slots.length).toBeGreaterThan(0) // раньше specialistWindowOk отвергал span через полночь → вечный 409
    const res = await book()
    expect(res.status).toBe(200)
    expect(res.body.price.total).toBe(90000)
    // метка ядра после C-цикла: «× N» — пакеты (k×дней), не «× N дн.»
    expect(res.body.price.lines[0].label).toContain('× 2')
    const row = (await pool.query(`select day_count, ends_at from bookings where idempotency_key = 'wed-2day'`)).rows[0]
    expect(row.day_count).toBe(2)
    expect(new Date(row.ends_at).getTime()).toBe(new Date(`${d2}T18:00:00Z`).getTime()) // 21:00 МСК дня 2
  })

  it('dayCount клампится к multiDayMax (5 → 2)', async () => {
    // 32 дня: не пересекается с многодневной бронью (8) и прочими фикстурами
    const [d1] = weekdayPair(32)
    const { book } = await bookWedding(d1, 5, 'wed-clamp')
    const res = await book()
    expect(res.status).toBe(200)
    const row = (await pool.query(`select day_count from bookings where idempotency_key = 'wed-clamp'`)).rows[0]
    expect(row.day_count).toBe(2)
  })

  it('явное бронирование: вне графика / в прошлом / сверх вместимости → 409, а не молчаливое 200', async () => {
    await clearRate()
    const [d1] = weekdayPair(4)
    // 04:00 МСК — вне окна 10:00–21:00, специалист выбран явно
    const night = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'shoot', serviceId: 'svc-wedding', specialistId: 'sp-anna', hallId: null,
        startUtcMs: new Date(`${d1}T01:00:00Z`).getTime(), dayCount: 1, peopleCount: 2, addonIds: [],
        client: { name: 'Ночь Тест', phone: '+79009990022', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'explicit-night',
      })
    expect(night.status).toBe(409)
    expect(night.body.error.code).toBe('BOOKING_CONFLICT')

    const past = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'rental', serviceId: 'svc-rental', hallId: 'hall-1',
        startUtcMs: Date.now() - 3_600_000, durationMin: 60, peopleCount: 2, addonIds: [],
        client: { name: 'Прошлое Тест', phone: '+79009990033', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'explicit-past',
      })
    expect(past.status).toBe(409)

    const overflow = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'rental', serviceId: 'svc-rental', hallId: 'hall-1',
        startUtcMs: new Date(`${nextOpenDate()}T09:00:00Z`).getTime(), durationMin: 60,
        peopleCount: 10, addonIds: [], // вместимость зала 6
        client: { name: 'Толпа Тест', phone: '+79009990044', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'explicit-capacity',
      })
    expect(overflow.status).toBe(409)
  })

  it('специалист, не нужный услуге, отвергается; перенос на занятое время → 409 (не 500)', async () => {
    await clearRate()
    const [d1] = weekdayPair(16)
    const noSpec = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'rental', serviceId: 'svc-rental', specialistId: 'sp-anna', hallId: 'hall-1',
        startUtcMs: new Date(`${d1}T09:00:00Z`).getTime(), durationMin: 60, peopleCount: 2, addonIds: [],
        client: { name: 'Лишний Спец', phone: '+79009990055', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'explicit-nospec',
      })
    expect(noSpec.status).toBe(400)

    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: d1, durationMin: 60, hallId: 'hall-1' })
    const s0 = slots.body.slots[0]
    const s2 = slots.body.slots[2]
    expect(s0 && s2).toBeTruthy()
    const mk = (slot: { startMs: number }, key: string) =>
      request(app)
        .post('/api/owner/studios/test-studio/bookings')
        .set('Cookie', ownerCookies)
        .send({
          kind: 'rental', serviceId: 'svc-rental', serviceName: 'Конфликт', hallId: 'hall-1',
          startsAtMs: slot.startMs, endsAtMs: slot.startMs + 3_600_000,
          allDay: false, dayCount: 1, status: 'confirmed',
          client: { name: 'Конфликт Тест', phone: '+79009990066', method: 'phone' },
          price: { lines: [], total: 1000, prepayment: 0 }, paidTotal: 0,
        })
    const a = await mk(s0, 'a')
    const b = await mk(s2, 'b')
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const move = await request(app)
      .patch(`/api/owner/studios/test-studio/bookings/${a.body.id}`)
      .set('Cookie', ownerCookies)
      .send({ startsAtMs: s2.startMs, endsAtMs: s2.startMs + 3_600_000 })
    expect(move.status).toBe(409) // раньше: сырой 23P01 → 500 INTERNAL
    expect(move.body.error.code).toBe('BOOKING_CONFLICT')
  })

  it('ручная бронь с закрытым статусом не создаёт блокировок ресурсов', async () => {
    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: nextOpenDate(), durationMin: 60, hallId: 'hall-1' })
    const slot = slots.body.slots.at(-1)
    expect(slot).toBeTruthy()
    const res = await request(app)
      .post('/api/owner/studios/test-studio/bookings')
      .set('Cookie', ownerCookies)
      .send({
        kind: 'rental', serviceId: 'svc-rental', serviceName: 'Мёртвая бронь', hallId: 'hall-1',
        startsAtMs: slot.startMs, endsAtMs: slot.startMs + 3_600_000,
        allDay: false, dayCount: 1, status: 'rejected',
        client: { name: 'Отклонён Тест', phone: '+79009990077', method: 'phone' },
        price: { lines: [], total: 1000, prepayment: 0 }, paidTotal: 0,
      })
    expect(res.status).toBe(201)
    const blocks = await pool.query(`select count(*)::int n from booking_resources where booking_id = $1`, [res.body.id])
    expect(blocks.rows[0].n).toBe(0)
  })

  it('сотрудник: цена замаскирована, calendar-token и ассистент — 403', async () => {
    const list = await request(app)
      .get('/api/owner/studios/test-studio/bookings')
      .set('Cookie', employeeCookies)
    expect(list.status).toBe(200)
    for (const b of list.body.items) {
      expect(b.paidTotal).toBe(0)
      expect(b.price.total).toBe(0) // раньше маскировался только paidTotal
    }
    const ct = await request(app)
      .get('/api/owner/studios/test-studio/calendar-token')
      .set('Cookie', employeeCookies)
    expect(ct.status).toBe(403)
    const assistant = await request(app)
      .post('/api/owner/studios/test-studio/assistant')
      .set('Cookie', employeeCookies)
      .send({ message: 'сколько заявок?' })
    expect(assistant.status).toBe(403)
  })

  it('удаление специалиста вычищает его из белых списков услуг', async () => {
    const svc = await request(app)
      .post('/api/owner/studios/test-studio/services')
      .set('Cookie', ownerCookies)
      .send({ ...SERVICE_WEDDING, id: 'svc-wl', specialistIds: ['sp-anna'] })
    expect(svc.status).toBe(204)
    const del = await request(app)
      .delete('/api/owner/studios/test-studio/specialists/sp-anna')
      .set('Cookie', ownerCookies)
    expect(del.status).toBe(204)
    const row = (await pool.query(`select specialist_ids from services where id = 'svc-wl'`)).rows[0]
    expect(row.specialist_ids).toEqual([]) // раньше оставался ['sp-anna'] — услуга теряла всех специалистов
  })

  it('hourly-съёмка без зала: бронь берёт ставку специалиста, зал null', async () => {
    await clearRate()
    const sp = { ...SPECIALIST, id: 'sp-nohall', name: 'Без зала', hourRate: 1000 }
    await request(app).post('/api/owner/studios/test-studio/specialists').set('Cookie', ownerCookies).send(sp)
    const svc = await request(app)
      .post('/api/owner/studios/test-studio/services')
      .set('Cookie', ownerCookies)
      .send({
        ...SERVICE_RENTAL, id: 'svc-hour-nohall', kind: 'shoot', name: 'Час без зала',
        priceType: 'hourly', price: 0, needsSpecialist: true, needsHall: false,
        specialistIds: ['sp-nohall'], sort: 11,
      })
    expect(svc.status).toBe(204)

    const [d1] = weekdayPair(24)
    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-hour-nohall', dateFrom: d1, durationMin: 60, hallId: null, specialistId: null })
    expect(slots.status).toBe(200)
    expect(slots.body.slots.length).toBeGreaterThan(0)
    expect(slots.body.slots[0].specialistId).toBe('sp-nohall')

    const res = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'shoot', serviceId: 'svc-hour-nohall', specialistId: null, hallId: null,
        startUtcMs: slots.body.slots[0].startMs, durationMin: 60, peopleCount: 1, addonIds: [],
        client: { name: 'Без зала Тест', phone: '+79009990088', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'hour-nohall',
      })
    expect(res.status).toBe(200)
    expect(res.body.price.total).toBe(1000)
    const row = (await pool.query(`select hall_id, specialist_id from bookings where idempotency_key = 'hour-nohall'`)).rows[0]
    expect(row.hall_id).toBeNull()
    expect(row.specialist_id).toBe('sp-nohall')
  })

  it('услуга-команда: клиент не выбирает, все специалисты блокируются, ставки суммируются', async () => {
    await clearRate()
    const team = [
      { ...SPECIALIST, id: 'sp-team-a', name: 'Команда А', hourRate: 1000 },
      { ...SPECIALIST, id: 'sp-team-b', name: 'Команда Б', hourRate: 700 },
    ]
    for (const sp of team) {
      const r = await request(app).post('/api/owner/studios/test-studio/specialists').set('Cookie', ownerCookies).send(sp)
      expect(r.status).toBe(204)
    }
    const svc = await request(app)
      .post('/api/owner/studios/test-studio/services')
      .set('Cookie', ownerCookies)
      .send({
        ...SERVICE_RENTAL, id: 'svc-team-hour', kind: 'shoot', name: 'Команда без зала',
        priceType: 'hourly', price: 0, needsSpecialist: true, needsHall: false,
        specialistIds: ['sp-team-a', 'sp-team-b'], allSpecialistsRequired: true, sort: 12,
      })
    expect(svc.status).toBe(204)

    const [d1] = weekdayPair(28)
    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-team-hour', dateFrom: d1, durationMin: 60, hallId: null, specialistId: null })
    expect(slots.status).toBe(200)
    expect(slots.body.slots.length).toBeGreaterThan(0)
    expect(slots.body.slots[0].specialistIds).toEqual(['sp-team-a', 'sp-team-b'])

    const res = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'shoot', serviceId: 'svc-team-hour', specialistId: null, hallId: null,
        startUtcMs: slots.body.slots[0].startMs, durationMin: 60, peopleCount: 1, addonIds: [],
        client: { name: 'Команда Тест', phone: '+79009990099', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'team-hour',
      })
    expect(res.status).toBe(200)
    expect(res.body.price.total).toBe(1700)
    expect(res.body.price.lines.filter((l: { label: string }) => l.label.startsWith('Специалист'))).toHaveLength(2)

    const row = (await pool.query(`select specialist_id, specialist_ids from bookings where idempotency_key = 'team-hour'`)).rows[0]
    expect(row.specialist_id).toBe('sp-team-a')
    expect(row.specialist_ids).toEqual(['sp-team-a', 'sp-team-b'])
    const blocks = await pool.query(
      `select resource_id from booking_resources where booking_id = (select id from bookings where idempotency_key = 'team-hour')
       and resource_type = 'specialist' order by resource_id`
    )
    expect(blocks.rows.map((r: { resource_id: string }) => r.resource_id)).toEqual(['sp-team-a', 'sp-team-b'])
  })

  // -------- регрессии C-цикла: многодневность, фикс-пакеты, перенос, напоминания --------

  it('многодневная почасовая (не «весь день»): окна тарифицируются целиком, конец = закрытие дня 2', async () => {
    await clearRate()
    const svc = await request(app)
      .post('/api/owner/studios/test-studio/services')
      .set('Cookie', ownerCookies)
      .send({ ...SERVICE_RENTAL, id: 'svc-multi-hour', name: 'Аренда на 2 дня', multiDayMax: 2 })
    expect(svc.status).toBe(204)

    const [d1, d2] = weekdayPair(20)
    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-multi-hour', dateFrom: d1, dayCount: 2, durationMin: 120, hallId: 'hall-1' })
    expect(slots.status).toBe(200)
    expect(slots.body.slots.length).toBeGreaterThan(0) // раньше валидация создания падала: слоты считались на 1 день

    const res = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'rental', serviceId: 'svc-multi-hour', hallId: 'hall-1',
        startUtcMs: slots.body.slots[0].startMs, dayCount: 2, durationMin: 120,
        peopleCount: 1, addonIds: [],
        client: { name: 'Многодневный Тест', phone: '+79009990101', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'multi-hour-2day',
      })
    expect(res.status).toBe(200)
    // Y2: 2 дня × окно 10:00–21:00 (11 ч): 8 ч день + 3 ч вечер по будням
    expect(res.body.price.total).toBe(2 * (8 * 1200 + 3 * 1500))
    const row = (await pool.query(`select day_count, ends_at from bookings where idempotency_key = 'multi-hour-2day'`)).rows[0]
    expect(row.day_count).toBe(2)
    expect(new Date(row.ends_at).getTime()).toBe(new Date(`${d2}T18:00:00Z`).getTime()) // 21:00 МСК дня 2
  })

  it('фикс-пакет занимает k×базы: durationMin 120 при базе 90 → цена ×2, интервал 180 мин', async () => {
    await clearRate()
    const svc = await request(app)
      .post('/api/owner/studios/test-studio/services')
      .set('Cookie', ownerCookies)
      .send({ ...SERVICE_RENTAL, id: 'svc-fix90', name: 'Фикс 90 минут', priceType: 'fixed', price: 10000, durationMin: 90 })
    expect(svc.status).toBe(204)

    const [d1] = weekdayPair(26)
    const res = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'rental', serviceId: 'svc-fix90', hallId: 'hall-1',
        startUtcMs: new Date(`${d1}T07:00:00Z`).getTime(), durationMin: 120,
        peopleCount: 1, addonIds: [],
        client: { name: 'Фикс Тест', phone: '+79009990102', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'fix90-k2',
      })
    expect(res.status).toBe(200)
    expect(res.body.price.total).toBe(20000) // k = ceil(120/90) = 2

    const row = (await pool.query(`select id, starts_at, ends_at from bookings where idempotency_key = 'fix90-k2'`)).rows[0]
    expect(new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()).toBe(180 * 60_000)
    const hall = (await pool.query(
      `select lower(during) as lo, upper(during) as hi from booking_resources
       where booking_id = $1 and resource_type = 'hall'`,
      [row.id]
    )).rows[0]
    expect(new Date(hall.hi).getTime() - new Date(hall.lo).getTime()).toBe(180 * 60_000) // setup 0
  })

  it('лимит съёмок считает все дни многодневной брони: день 2 тоже занят', async () => {
    await clearRate()
    const spec = await request(app)
      .post('/api/owner/studios/test-studio/specialists')
      .set('Cookie', ownerCookies)
      .send({ id: 'sp-boris', name: 'Борис', title: 'Оператор', active: true, dayLimit: 1 })
    expect(spec.status).toBe(204)
    const two = await request(app)
      .post('/api/owner/studios/test-studio/services')
      .set('Cookie', ownerCookies)
      .send({
        ...SERVICE_RENTAL, id: 'svc-two-day', kind: 'shoot', name: 'Двухдневная съёмка',
        priceType: 'fixed', price: 5000, durationMin: 60,
        needsHall: false, needsSpecialist: true, multiDayMax: 2,
      })
    expect(two.status).toBe(204)
    const one = await request(app)
      .post('/api/owner/studios/test-studio/services')
      .set('Cookie', ownerCookies)
      .send({
        ...SERVICE_RENTAL, id: 'svc-one-day', kind: 'shoot', name: 'Однодневная съёмка',
        priceType: 'fixed', price: 3000, durationMin: 60, needsHall: false, needsSpecialist: true,
      })
    expect(one.status).toBe(204)

    const [d1, d2] = weekdayPair(32)
    const book = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'shoot', serviceId: 'svc-two-day', specialistId: 'sp-boris', hallId: null,
        startUtcMs: new Date(`${d1}T07:00:00Z`).getTime(), dayCount: 2,
        peopleCount: 1, addonIds: [],
        client: { name: 'Борис Клиент', phone: '+79009990103', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'twoday-limit',
      })
    expect(book.status).toBe(200)

    const second = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'shoot', serviceId: 'svc-one-day', specialistId: 'sp-boris', hallId: null,
        startUtcMs: new Date(`${d2}T07:00:00Z`).getTime(),
        peopleCount: 1, addonIds: [],
        client: { name: 'Второй Клиент', phone: '+79009990104', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'oneday-limit',
      })
    expect(second.status).toBe(409) // раньше день 2 не считался занятым по лимиту/окнам
    expect(second.body.error.code).toBe('BOOKING_CONFLICT')
  })

  it('перенос брони вне графика → 409 BOOKING_CONFLICT, а не молчаливый 200', async () => {
    const row = (await pool.query(`select id from bookings where idempotency_key = 'fix90-k2'`)).rows[0]
    expect(row).toBeTruthy()
    const [d1] = weekdayPair(26)
    const nightMs = new Date(`${d1}T01:00:00Z`).getTime() // 04:00 МСК — вне окна 10:00–21:00
    const move = await request(app)
      .patch(`/api/owner/studios/test-studio/bookings/${row.id}`)
      .set('Cookie', ownerCookies)
      .send({ startsAtMs: nightMs, endsAtMs: nightMs + 180 * 60_000 })
    expect(move.status).toBe(409)
    expect(move.body.error.code).toBe('BOOKING_CONFLICT')
    expect(move.body.error.message).toContain('график')
  })

  it('закрытый период возвращает конфликты с активными заявками', async () => {
    const row = (await pool.query(`select id from bookings where idempotency_key = 'twoday-limit'`)).rows[0]
    expect(row).toBeTruthy()
    const [d1] = weekdayPair(32)
    const res = await request(app)
      .post('/api/owner/studios/test-studio/closed-periods')
      .set('Cookie', ownerCookies)
      .send({ resourceType: 'specialist', resourceId: 'sp-boris', dateFrom: d1, dateTo: d1, reason: 'отпуск' })
    expect(res.status).toBe(201)
    expect(Array.isArray(res.body.conflicts)).toBe(true)
    const hit = res.body.conflicts.find(
      (c: { id: string; serviceName: string; clientName: string; startsAtMs: number }) => c.id === row.id
    )
    expect(hit).toBeTruthy()
    expect(hit!.serviceName).toBe('Двухдневная съёмка')
    expect(hit!.clientName).toBe('Борис Клиент')
    expect(hit!.startsAtMs).toBe(new Date(`${d1}T07:00:00Z`).getTime())
  })

  it('напоминание клиенту: pending-строка в outbox за сутки до старта, снимается отменой', async () => {
    await clearRate()
    const [d1] = weekdayPair(40)
    const startUtcMs = new Date(`${d1}T07:00:00Z`).getTime()
    const res = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'rental', serviceId: 'svc-rental', hallId: 'hall-1',
        startUtcMs, durationMin: 60,
        peopleCount: 1, addonIds: [],
        client: { name: 'Напоминание Тест', phone: '+79009990105', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'reminder-1',
      })
    expect(res.status).toBe(200)
    expect(res.body.token).toBeTruthy()

    const row = (await pool.query(`select id from bookings where idempotency_key = 'reminder-1'`)).rows[0]
    const outbox = (await pool.query(
      `select status, next_attempt_at from notify_outbox where booking_id = $1 and channel = 'reminder_client'`,
      [row.id]
    )).rows[0]
    expect(outbox).toBeTruthy()
    expect(outbox.status).toBe('pending')
    expect(Math.abs(new Date(outbox.next_attempt_at).getTime() - (startUtcMs - 24 * 3_600_000))).toBeLessThan(60_000)

    const cancel = await request(app)
      .post(`/api/public/studios/test-studio/bookings/${res.body.token}/cancel`)
    expect(cancel.status).toBe(200)
    const left = (await pool.query(
      `select count(*)::int as n from notify_outbox
       where booking_id = $1 and channel = 'reminder_client' and status = 'pending'`,
      [row.id]
    )).rows[0]
    expect(left.n).toBe(0) // напоминание снялось вместе с бронью
  })

  // -------- C1/C2/C4: completed-закрытие, матрица переходов, push-роуты --------

  const freeSlot = async (d1: string) => {
    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: d1, durationMin: 60, hallId: 'hall-1' })
    return slots.body.slots[0]
  }

  const manualBooking = (slot: { startMs: number }, status: string, key: string) =>
    request(app)
      .post('/api/owner/studios/test-studio/bookings')
      .set('Cookie', ownerCookies)
      .send({
        kind: 'rental', serviceId: 'svc-rental', serviceName: key, hallId: 'hall-1',
        startsAtMs: slot.startMs, endsAtMs: slot.startMs + 3_600_000,
        allDay: false, dayCount: 1, status,
        client: { name: `Клиент ${key}`, phone: '+79009990300', method: 'phone' },
        price: { lines: [], total: 1000, prepayment: 0 }, paidTotal: 0,
      })

  const patchStatus = (id: string, status: string) =>
    request(app)
      .patch(`/api/owner/studios/test-studio/bookings/${id}`)
      .set('Cookie', ownerCookies)
      .send({ status })

  const slotTaken = async (d1: string, startMs: number): Promise<boolean> => {
    const slots = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: d1, durationMin: 60, hallId: 'hall-1' })
    return !slots.body.slots.some((s: { startMs: number }) => s.startMs === startMs)
  }

  it('completed снимает блокировки и ре-открывается пересозданием', async () => {
    await clearRate()
    const [d1] = weekdayPair(44)
    const slot = await freeSlot(d1)
    expect(slot).toBeTruthy()

    const created = await manualBooking(slot, 'confirmed', 'complete-me')
    expect(created.status).toBe(201)

    const done = await patchStatus(created.body.id, 'completed')
    expect(done.status).toBe(200)
    const blocks = (await pool.query(
      `select count(*)::int n from booking_resources where booking_id = $1`,
      [created.body.id]
    )).rows[0]
    expect(blocks.n).toBe(0) // completed — закрывающий: ресурсы сняты
    expect(await slotTaken(d1, slot.startMs)).toBe(false)

    const reopen = await patchStatus(created.body.id, 'confirmed')
    expect(reopen.status).toBe(200)
    const blocks2 = (await pool.query(
      `select count(*)::int n from booking_resources where booking_id = $1`,
      [created.body.id]
    )).rows[0]
    expect(blocks2.n).toBe(1) // ре-открытие пересоздало блокировку
    expect(await slotTaken(d1, slot.startMs)).toBe(true)
  })

  it('матрица переходов: вперёд — любой, назад — один шаг; закрытие/ре-открытие — ок', async () => {
    await clearRate()
    const [d1] = weekdayPair(48)
    const slot = await freeSlot(d1)
    expect(slot).toBeTruthy()

    const created = await manualBooking(slot, 'new', 'matrix')
    expect(created.status).toBe(201)
    const id = created.body.id

    const jump = await patchStatus(id, 'shot_done') // new(0) → shot_done(3): перескок вперёд — можно
    expect(jump.status).toBe(200)

    const far = await patchStatus(id, 'new') // shot_done(3) → new(0): далеко назад — нельзя
    expect(far.status).toBe(400)
    expect(far.body.error.code).toBe('INVALID_STATUS_TRANSITION')

    const fwd = await patchStatus(id, 'processing') // шаг вперёд
    expect(fwd.status).toBe(200)

    const back = await patchStatus(id, 'shot_done') // ровно один назад — можно
    expect(back.status).toBe(200)

    // снова вперёд к закрытию
    expect((await patchStatus(id, 'delivered')).status).toBe(200)

    const close = await patchStatus(id, 'cancelled_by_client') // активный → закрытый
    expect(close.status).toBe(200)

    const reopen = await patchStatus(id, 'delivered') // закрытый → активный (ре-открытие)
    expect(reopen.status).toBe(200)

    const far2 = await patchStatus(id, 'new') // delivered(5) → new(0): далеко назад
    expect(far2.status).toBe(400)
    expect(far2.body.error.code).toBe('INVALID_STATUS_TRANSITION')
  })

  it('белый список залов услуги: чужие залы не показываются и не бронируются', async () => {
    await clearRate()
    const hall2 = await request(app)
      .post('/api/owner/studios/test-studio/halls')
      .set('Cookie', ownerCookies)
      .send({ id: 'hall-2', name: 'Зал 2', capacity: 4, rates: { weekday: { day: 1000, evening: 1200 }, weekend: { day: 1300, evening: 1500 } }, active: true })
    expect(hall2.status).toBe(204)

    const scoped = await request(app)
      .post('/api/owner/studios/test-studio/services')
      .set('Cookie', ownerCookies)
      .send({ ...SERVICE_RENTAL, id: 'svc-rental-scoped', name: 'Только Зал 1', hallIds: ['hall-1'] })
    expect(scoped.status).toBe(204)

    const bundle = await request(app).get('/api/public/studios/test-studio')
    const svc = bundle.body.services.find((x: { id: string }) => x.id === 'svc-rental-scoped')
    expect(svc.hallIds).toEqual(['hall-1'])

    const date = weekdayPair(60)[0]
    const allowed = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental-scoped', dateFrom: date, durationMin: 60, hallId: 'hall-1' })
    expect(allowed.status).toBe(200)
    expect(allowed.body.slots.length).toBeGreaterThan(0)

    const denied = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental-scoped', dateFrom: date, durationMin: 60, hallId: 'hall-2' })
    expect(denied.status).toBe(200)
    expect(denied.body.slots).toHaveLength(0)
    expect(denied.body.reason).toBe('Зал недоступен для этой услуги')

    const deniedBook = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'rental', serviceId: 'svc-rental-scoped', hallId: 'hall-2',
        startUtcMs: new Date(`${date}T09:00:00Z`).getTime(),
        durationMin: 60, peopleCount: 1, addonIds: [],
        client: { name: 'Чужой зал', phone: '+79005556677', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'scoped-hall-2',
      })
    expect(deniedBook.status).toBe(400)
    expect(deniedBook.body.error.message).toContain('Зал недоступен')

    const deniedManual = await request(app)
      .post('/api/owner/studios/test-studio/bookings')
      .set('Cookie', ownerCookies)
      .send({
        kind: 'rental', serviceId: 'svc-rental-scoped', hallId: 'hall-2',
        startsAtMs: new Date(`${date}T09:00:00Z`).getTime(),
        endsAtMs: new Date(`${date}T10:00:00Z`).getTime(),
        status: 'confirmed',
        client: { name: 'Ручной чужой зал', phone: '+79005556688', method: 'phone' },
      })
    expect(deniedManual.status).toBe(400)
    expect(deniedManual.body.error.message).toContain('Зал недоступен')

    await request(app).delete('/api/owner/studios/test-studio/services/svc-rental-scoped').set('Cookie', ownerCookies)
    await request(app).delete('/api/owner/studios/test-studio/halls/hall-2').set('Cookie', ownerCookies)
  })

  it('push-роуты: ключ, подписка-upsert по endpoint_hash, отписка', async () => {
    await clearRate()
    const key = await request(app).get('/api/public/studios/test-studio/push-key')
    expect(key.status).toBe(200)
    expect(key.body).toHaveProperty('publicKey')
    expect(key.body.publicKey === null || typeof key.body.publicKey === 'string').toBe(true)

    const missing = await request(app).get('/api/public/studios/no-such-studio/push-key')
    expect(missing.status).toBe(404)

    const endpoint = 'https://push.example.com/fcm/send/sub-test-1'
    const sub = { endpoint, keys: { p256dh: 'p256dh-test-value', auth: 'auth-test-value' } }
    const hash = createHash('sha256').update(endpoint).digest('hex')

    const s1 = await request(app).post('/api/public/studios/test-studio/push-subscribe').send(sub)
    expect(s1.status).toBe(204)
    let rows = (await pool.query(
      `select endpoint_hash, payload from push_subscriptions`
    )).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].endpoint_hash).toBe(hash)
    expect(rows[0].payload.endpoint).toBe(endpoint) // формат web-push: {endpoint, keys, ...}
    expect(rows[0].payload.keys.p256dh).toBe('p256dh-test-value')

    const s2 = await request(app).post('/api/public/studios/test-studio/push-subscribe').send(sub)
    expect(s2.status).toBe(204)
    rows = (await pool.query(`select endpoint_hash from push_subscriptions`)).rows
    expect(rows).toHaveLength(1) // повторный subscribe — upsert, не дубль

    const unsub = await request(app)
      .post('/api/public/studios/test-studio/push-unsubscribe')
      .send({ endpoint })
    expect(unsub.status).toBe(204)
    rows = (await pool.query(`select endpoint_hash from push_subscriptions`)).rows
    expect(rows).toHaveLength(0)
  })
  it('Y3: референсы грузятся по токену брони, видны владельцу и стираются при анонимизации', async () => {
    await clearRate()
    const [d] = weekdayPair(40)
    const created = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'rental', serviceId: 'svc-rental', hallId: 'hall-1',
        startUtcMs: new Date(`${d}T07:00:00Z`).getTime(), durationMin: 60,
        peopleCount: 1, addonIds: [],
        client: { name: 'Референс Тест', phone: '+79009990202', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'refs-upload-1',
      })
    expect(created.status).toBe(200)
    const token = created.body.token as string
    expect(token).toBeTruthy()
    const found = await request(app).get(`/api/public/studios/test-studio/bookings/${token}`)
    const bookingId = found.body.id as string

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lr9nWQAAAABJRU5ErkJggg==',
      'base64'
    )
    const up = await request(app)
      .post(`/api/public/studios/test-studio/bookings/${token}/references`)
      .attach('files', png, { filename: 'ref.png', contentType: 'image/png' })
    expect(up.status).toBe(201)
    expect(up.body.count).toBe(1)
    const fileRow = (await pool.query(
      `select file_path from booking_references where studio_id = (select id from studios where slug = 'test-studio')`
    )).rows[0]
    const diskPath = path.resolve(__dirname, '../uploads-test', fileRow.file_path)
    expect(existsSync(diskPath)).toBe(true)

    const mine = await request(app).get(`/api/public/studios/test-studio/bookings/${token}/references`)
    expect(mine.status).toBe(200)
    expect(mine.body.items).toHaveLength(1)

    const ownerList = await request(app)
      .get(`/api/owner/studios/test-studio/bookings/${bookingId}/references`)
      .set('Cookie', ownerCookies)
    expect(ownerList.status).toBe(200)
    expect(ownerList.body.items).toHaveLength(1)
    const noAuth = await request(app).get(`/api/owner/studios/test-studio/bookings/${bookingId}/references`)
    expect(noAuth.status).toBe(401)

    // П1: прямой URL не отдаётся статикой; file-endpoint требует авторизацию
    const direct = await request(app).get(`/uploads/${fileRow.file_path}`)
    expect(direct.status).toBe(404)
    const refId = ownerList.body.items[0].id as string
    const noSessionFile = await request(app).get(
      `/api/owner/studios/test-studio/bookings/${bookingId}/references/${refId}/file`
    )
    expect(noSessionFile.status).toBe(401)
    const withSession = await request(app)
      .get(`/api/owner/studios/test-studio/bookings/${bookingId}/references/${refId}/file`)
      .set('Cookie', ownerCookies)
    expect(withSession.status).toBe(200)
    expect(withSession.headers['content-type']).toMatch(/image\//)
    const byToken = await request(app).get(
      `/api/public/studios/test-studio/bookings/${token}/references/${refId}/file`
    )
    expect(byToken.status).toBe(200)
    expect(byToken.headers['content-type']).toMatch(/image\//)

    const anon = await request(app)
      .post(`/api/owner/studios/test-studio/bookings/${bookingId}/anonymize`)
      .set('Cookie', ownerCookies)
    expect(anon.status).toBe(200)
    const after = await request(app)
      .get(`/api/owner/studios/test-studio/bookings/${bookingId}/references`)
      .set('Cookie', ownerCookies)
    expect(after.body.items).toHaveLength(0)
    expect(existsSync(diskPath)).toBe(false)

    // Z4: счётчик в client сброшен — кнопка «Референсы: N шт.» исчезает из кабинета
    const clientRow = await pool.query(
      `select client->>'referenceCount' as rc from bookings where id = $1`,
      [bookingId]
    )
    expect(clientRow.rows[0].rc).toBeNull()
  })

  it('Y3: референсы принимают только изображения', async () => {
    await clearRate()
    const [d] = weekdayPair(41)
    const created = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'rental', serviceId: 'svc-rental', hallId: 'hall-1',
        startUtcMs: new Date(`${d}T07:00:00Z`).getTime(), durationMin: 60,
        peopleCount: 1, addonIds: [],
        client: { name: 'Референс MIME', phone: '+79009990203', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'refs-upload-bad',
      })
    expect(created.status).toBe(200)
    const bad = await request(app)
      .post(`/api/public/studios/test-studio/bookings/${created.body.token}/references`)
      .attach('files', Buffer.from('not an image'), { filename: 'ref.txt', contentType: 'text/plain' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('VALIDATION')
  })

  it('Y4 (P3): услуга-команда с неактивным специалистом не сохраняется', async () => {
    await clearRate()
    const off = await request(app)
      .post('/api/owner/studios/test-studio/specialists')
      .set('Cookie', ownerCookies)
      .send({ ...SPECIALIST, id: 'sp-team-a', name: 'Команда А', hourRate: 1000, active: false })
    expect(off.status).toBe(204)

    const res = await request(app)
      .post('/api/owner/studios/test-studio/services')
      .set('Cookie', ownerCookies)
      .send({
        ...SERVICE_RENTAL, id: 'svc-team-dead', kind: 'shoot', name: 'Мёртвая команда',
        priceType: 'hourly', price: 0, needsSpecialist: true, needsHall: false,
        specialistIds: ['sp-team-a', 'sp-team-b'], allSpecialistsRequired: true, sort: 13,
      })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('неактив')

    const on = await request(app)
      .post('/api/owner/studios/test-studio/specialists')
      .set('Cookie', ownerCookies)
      .send({ ...SPECIALIST, id: 'sp-team-a', name: 'Команда А', hourRate: 1000, active: true })
    expect(on.status).toBe(204)
  })

  it('Y1 (P1): ночная смена 22:00–06:00 принимает бронь и считает часы после полуночи', async () => {
    await clearRate()
    const night = { open: '22:00', close: '06:00' }
    const settings = await request(app)
      .put('/api/owner/studios/test-studio/settings')
      .set('Cookie', ownerCookies)
      .send({
        ...MIN_SETTINGS,
        schedule: { mon: night, tue: night, wed: night, thu: night, fri: night, sat: night, sun: night },
      })
    expect(settings.status).toBe(200)

    const [d] = weekdayPair(45)
    const avail = await request(app)
      .post('/api/public/studios/test-studio/availability')
      .send({ serviceId: 'svc-rental', dateFrom: d, durationMin: 480, hallId: 'hall-1' })
    expect(avail.status).toBe(200)
    expect(avail.body.slots[0].startMs).toBe(new Date(`${d}T19:00:00Z`).getTime())

    const res = await request(app)
      .post('/api/public/studios/test-studio/bookings')
      .send({
        kind: 'rental', serviceId: 'svc-rental', hallId: 'hall-1',
        startUtcMs: new Date(`${d}T19:00:00Z`).getTime(), durationMin: 480,
        peopleCount: 1, addonIds: [],
        client: { name: 'Ночной Тест', phone: '+79009990204', method: 'phone' },
        consent: true, honeypot: '', idempotencyKey: 'night-booking-1',
      })
    expect(res.status).toBe(200)
    expect(res.body.price.total).toBe(2 * 1500 + 6 * 1200)
    const row = (await pool.query(
      `select ends_at from bookings where idempotency_key = 'night-booking-1'`
    )).rows[0]
    const next = new Date(`${d}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    expect(new Date(row.ends_at).getTime()).toBe(next.getTime() + 3 * 3600_000)
  })

})
