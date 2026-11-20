// Регрессии демо-адаптера: зеркальность боевому createPublicBooking/getSlots
// (авто-подбор зала/специалиста, белые списки, конфликт «любой свободный»).
// Демо sacred: эти тесты защищают поведение, на которое опираются e2e.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { demoBackend } from '@/backend/demo'
import type { CreateBookingPayload } from '@/core/schema'
import { addDaysToDateString, zonedToUtcMs } from '@/core/time'
import type { WeekSchedule } from '@/core/types'

// демо-адаптер хранит состояние в localStorage — в Node подставляем заглушку
class MemLocalStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
}

const SLUG = 'demo-regress'

const SCHEDULE = {
  mon: { open: '10:00', close: '21:00' },
  tue: { open: '10:00', close: '21:00' },
  wed: { open: '10:00', close: '21:00' },
  thu: { open: '10:00', close: '21:00' },
  fri: { open: '10:00', close: '21:00' },
  sat: { open: '10:00', close: '20:00' },
  sun: null,
} as const

const db = {
  settings: {
    slug: SLUG,
    name: 'Демо-студия',
    tz: 'Europe/Moscow',
    schedule: SCHEDULE,
    closedDates: [],
    cancellation: { freeHours: 48, text: '' },
    travelZones: [{ id: 'city', name: 'по городу', minutesBefore: 0, minutesAfter: 0, extraFee: 0 }],
    eveningFrom: '18:00',
  },
  specialists: [
    { id: 's1', name: 'Анна', title: 'Фотограф', active: true, dayLimit: 3, hourRate: 1500 },
    { id: 's2', name: 'Марк', title: '', active: true, dayLimit: 3, hourRate: 1200 },
  ],
  halls: [
    { id: 'h1', name: 'Зал 1', capacity: 6, active: true, rates: { weekday: { day: 1000, evening: 1500 }, weekend: { day: 1200, evening: 1800 } } },
    { id: 'h2', name: 'Зал 2', capacity: 6, active: true, rates: { weekday: { day: 1000, evening: 1500 }, weekend: { day: 1200, evening: 1800 } } },
  ],
  services: [
    { id: 'svc-hourly', kind: 'rental', name: 'Аренда', description: '', priceType: 'hourly', price: 0, durationMin: 60, includes: [], deliverableText: '', deadlineDays: 0, prepayment: { type: 'amount', value: 0 }, needsSpecialist: false, needsHall: true, fullDay: false, multiDayMax: 1, autoConfirm: true, setupMin: 0, cleanupMin: 0, sort: 1 },
    { id: 'svc-hourly-nohall', kind: 'rental', name: 'Аренда легаси', description: '', priceType: 'hourly', price: 0, durationMin: 60, includes: [], deliverableText: '', deadlineDays: 0, prepayment: { type: 'amount', value: 0 }, needsSpecialist: false, needsHall: false, fullDay: false, multiDayMax: 1, autoConfirm: true, setupMin: 0, cleanupMin: 0, sort: 2 },
    { id: 'svc-shoot', kind: 'shoot', name: 'Съёмка с фотографом', description: '', priceType: 'hourly', price: 0, durationMin: 60, includes: [], deliverableText: '', deadlineDays: 0, prepayment: { type: 'amount', value: 0 }, needsSpecialist: true, needsHall: true, fullDay: false, multiDayMax: 1, autoConfirm: true, setupMin: 0, cleanupMin: 0, sort: 3 },
  ],
  addons: [],
  portfolio: [],
  bookings: [],
}

// псевдозанятость детерминирована, но неизвестна заранее: сначала спрашиваем
// слоты, потом бронируем найденный свободный старт (как реальный клиент)
function openDate(daysAhead: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  while (d.getDay() === 0) d.setDate(d.getDate() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

let keySeq = 0
function payload(over: Partial<CreateBookingPayload> & Pick<CreateBookingPayload, 'serviceId' | 'kind' | 'startUtcMs'>): CreateBookingPayload {
  keySeq++
  return {
    slug: SLUG,
    specialistId: null,
    hallId: null,
    durationMin: 60,
    peopleCount: 2,
    offsite: false,
    travelZoneId: null,
    addonIds: [],
    client: { name: 'Клиент Тест', phone: '+79001234567', method: 'phone' },
    consent: true,
    honeypot: '',
    idempotencyKey: `demo-regress-${keySeq}-${Date.now()}`,
    ...over,
  }
}

beforeAll(() => {
  vi.stubGlobal('localStorage', new MemLocalStorage())
  localStorage.setItem(`pf_demo_${SLUG}`, JSON.stringify(db))
})

describe('демо-адаптер: регрессии авто-подбора и белых списков', () => {
  it('авто-режим зала (hallId=null, needsHall): слоты есть, а не «Выберите зал»', async () => {
    const res = await demoBackend.getAvailability({
      slug: SLUG, serviceId: 'svc-hourly', dateFrom: openDate(5),
      specialistId: null, hallId: null, offsite: false, travelZoneId: null,
    })
    expect(res.slots.length).toBeGreaterThan(0)
  })

  it('создание без зала подбирает зал (не падает «нужен зал»)', async () => {
    const date = openDate(6)
    const av = await demoBackend.getAvailability({
      slug: SLUG, serviceId: 'svc-hourly', dateFrom: date,
      specialistId: null, hallId: null, offsite: false, travelZoneId: null,
    })
    expect(av.slots.length).toBeGreaterThan(0)
    const res = await demoBackend.createBooking(
      payload({ kind: 'rental', serviceId: 'svc-hourly', startUtcMs: av.slots[0].startMs, hallId: null })
    )
    expect(res.ok).toBe(true)
    const stored = JSON.parse(localStorage.getItem(`pf_demo_${SLUG}`) ?? '{"bookings":[]}') as { bookings: { hallId: string | null }[] }
    expect(['h1', 'h2']).toContain(stored.bookings[0].hallId)
  })

  it('почасовая услуга с needsHall=false (легаси) бронируется и занимает зал', async () => {
    const date = openDate(7)
    const av = await demoBackend.getAvailability({
      slug: SLUG, serviceId: 'svc-hourly-nohall', dateFrom: date,
      specialistId: null, hallId: null, offsite: false, travelZoneId: null,
    })
    expect(av.slots.length).toBeGreaterThan(0)
    const res = await demoBackend.createBooking(
      payload({ kind: 'rental', serviceId: 'svc-hourly-nohall', startUtcMs: av.slots[0].startMs })
    )
    expect(res.ok).toBe(true)
    expect(res.ok ? (res.price?.total ?? 0) : 0).toBeGreaterThan(0)
    const stored = JSON.parse(localStorage.getItem(`pf_demo_${SLUG}`) ?? '{"bookings":[]}') as { bookings: { hallId: string | null }[] }
    expect(stored.bookings.at(-1)!.hallId).not.toBeNull()
  })

  it('«любой свободный» назначает специалиста, ставка в цене, повтор — конфликт', async () => {
    const date = openDate(8)
    const av = await demoBackend.getAvailability({
      slug: SLUG, serviceId: 'svc-shoot', dateFrom: date,
      specialistId: null, hallId: null, offsite: false, travelZoneId: null,
    })
    expect(av.slots.length).toBeGreaterThan(0)
    expect(av.slots[0].specialistId).toBeTruthy()
    const start = av.slots[0].startMs
    const first = await demoBackend.createBooking(
      payload({ kind: 'shoot', serviceId: 'svc-shoot', startUtcMs: start })
    )
    expect(first.ok).toBe(true)
    const stored = JSON.parse(localStorage.getItem(`pf_demo_${SLUG}`) ?? '{"bookings":[]}') as { bookings: { specialistId: string | null; price: { lines: { label: string }[] } }[] }
    const rec = stored.bookings.at(-1)!
    expect(rec.specialistId).toBeTruthy()
    expect(rec.price.lines.some((l) => l.label.startsWith('Специалист:'))).toBe(true)
    // тот же слот с тем же специалистом — уже занято
    const second = await demoBackend.createBooking(
      payload({ kind: 'shoot', serviceId: 'svc-shoot', startUtcMs: start, specialistId: rec.specialistId })
    )
    expect(second.ok).toBe(false)
  })

  it('белый список залов: чужой зал недоступен', async () => {
    const withList = JSON.parse(localStorage.getItem(`pf_demo_${SLUG}`)!) as typeof db
    withList.services = withList.services.map((s) => (s.id === 'svc-hourly' ? { ...s, hallIds: ['h2'] } : s))
    localStorage.setItem(`pf_demo_${SLUG}`, JSON.stringify(withList))
    const res = await demoBackend.getAvailability({
      slug: SLUG, serviceId: 'svc-hourly', dateFrom: openDate(9),
      specialistId: null, hallId: 'h1', offsite: false, travelZoneId: null,
    })
    expect(res.slots).toHaveLength(0)
    expect(res.reason).toContain('Зал недоступен')
  })

  it('П4: анонимизация сбрасывает referenceCount в demo', async () => {
    const date = openDate(10)
    const av = await demoBackend.getAvailability({
      slug: SLUG, serviceId: 'svc-shoot', dateFrom: date,
      specialistId: null, hallId: null, offsite: false, travelZoneId: null,
    })
    expect(av.slots.length).toBeGreaterThan(0)
    const created = await demoBackend.createBooking(
      payload({
        kind: 'shoot', serviceId: 'svc-shoot', startUtcMs: av.slots[0].startMs,
        client: { name: 'Аноним Тест', phone: '+79001112233', method: 'phone', referenceCount: 2 },
      })
    )
    expect(created.ok).toBe(true)
    const before = JSON.parse(localStorage.getItem(`pf_demo_${SLUG}`)!) as { bookings: { id: string; client: { referenceCount?: number } }[] }
    const rec = before.bookings.at(-1)!
    expect(rec.client.referenceCount).toBe(2)
    await demoBackend.ownerAnonymizeClient(SLUG, rec.id)
    const after = JSON.parse(localStorage.getItem(`pf_demo_${SLUG}`)!) as { bookings: { id: string; client: { referenceCount?: number } }[] }
    expect(after.bookings.find((b) => b.id === rec.id)!.client.referenceCount).toBeUndefined()
  })
})

// ---------- многодневность, к-кратность фикс-пакетов, день-лимиты ----------

const SLUG2 = 'demo-multiday'
const TZ = 'Europe/Moscow'

// Короткое окно: многодневность по ядру блокирует целые окна каждого дня, а
// pseudoBusy даёт каждому ресурсу 2-часовой блок ежедневно — при длинном окне
// «чистых» дней в демо не бывает. На 2-часовом окне блок мимо окна — день чист.
const SHORT_SCHEDULE = {
  mon: { open: '10:00', close: '12:00' },
  tue: { open: '10:00', close: '12:00' },
  wed: { open: '10:00', close: '12:00' },
  thu: { open: '10:00', close: '12:00' },
  fri: { open: '10:00', close: '12:00' },
  sat: { open: '10:00', close: '12:00' },
  sun: null,
} as const

// клон общего db + фикстуры многодневных услуг (общий db не мутируем);
// график в клоне — короткие окна, поэтому тип поля расширяем до WeekSchedule
type DemoDbClone = Omit<typeof db, 'settings'> & {
  settings: Omit<(typeof db)['settings'], 'schedule'> & { schedule: WeekSchedule }
}

function seedMultiDb() {
  const base = JSON.parse(JSON.stringify(db)) as DemoDbClone
  base.settings.schedule = SHORT_SCHEDULE as WeekSchedule
  base.specialists.push({ id: 's-lim', name: 'Лида', title: '', active: true, dayLimit: 1, hourRate: 0 })
  base.services.push(
    { id: 'svc-multi', kind: 'rental', name: 'Многодневная аренда', description: '', priceType: 'hourly', price: 0, durationMin: 60, includes: [], deliverableText: '', deadlineDays: 0, prepayment: { type: 'amount', value: 0 }, needsSpecialist: false, needsHall: true, fullDay: false, multiDayMax: 2, autoConfirm: true, setupMin: 0, cleanupMin: 0, sort: 4 },
    { id: 'svc-fixed', kind: 'shoot', name: 'Фикс-пакет', description: '', priceType: 'fixed', price: 10000, durationMin: 90, includes: [], deliverableText: '', deadlineDays: 0, prepayment: { type: 'amount', value: 0 }, needsSpecialist: false, needsHall: false, fullDay: false, multiDayMax: 1, autoConfirm: true, setupMin: 0, cleanupMin: 0, sort: 5 },
    { id: 'svc-spec-fixed', kind: 'shoot', name: 'Съёмка фикс', description: '', priceType: 'fixed', price: 1000, durationMin: 60, includes: [], deliverableText: '', deadlineDays: 0, prepayment: { type: 'amount', value: 0 }, needsSpecialist: true, needsHall: false, fullDay: false, multiDayMax: 2, autoConfirm: true, setupMin: 0, cleanupMin: 0, sort: 6 },
  )
  localStorage.setItem(`pf_demo_${SLUG2}`, JSON.stringify(base))
}

// старт пн–чт: два открытых дня подряд и будничные тарифы (сб — weekend)
function weekdayDate(daysAhead: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  while (d.getDay() === 0 || d.getDay() === 5 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function getAvail(over: Partial<Parameters<typeof demoBackend.getAvailability>[0]> & Pick<Parameters<typeof demoBackend.getAvailability>[0], 'dateFrom'>) {
  return demoBackend.getAvailability({
    slug: SLUG2, serviceId: 'svc-multi',
    specialistId: null, hallId: null, offsite: false, travelZoneId: null,
    ...over,
  })
}

describe('демо-адаптер: многодневность, фикс k×базы, день-лимиты', () => {
  it('многодневная почасовая: слот есть, цена = часы/день × дни, конец = закрытие дня 2', async () => {
    seedMultiDb()
    // псевдозанятость детерминирована, но неизвестна заранее: подбираем дату,
    // где у одного из залов чисты оба дня (спрашиваем сам адаптер)
    let date = ''
    let startMs = 0
    for (let off = 21; off < 140 && !date; off++) {
      const d = weekdayDate(off)
      const av = await getAvail({ dateFrom: d, dayCount: 2, durationMin: 120 })
      if (av.slots.length > 0) {
        date = d
        startMs = av.slots[0].startMs
      }
    }
    expect(date).not.toBe('')
    const res = await demoBackend.createBooking(
      payload({ slug: SLUG2, kind: 'rental', serviceId: 'svc-multi', startUtcMs: startMs, dayCount: 2, durationMin: 120 })
    )
    expect(res.ok).toBe(true)
    // старт у открытия, окна по 2 ч: 2 ч/день × 2 дня × weekday.day 1000
    expect(res.ok ? res.price?.total : 0).toBe(4000)
    const stored = JSON.parse(localStorage.getItem(`pf_demo_${SLUG2}`)!) as { bookings: { startsAtMs: number; endsAtMs: number }[] }
    const rec = stored.bookings.at(-1)!
    expect(rec.startsAtMs).toBe(startMs)
    expect(rec.endsAtMs).toBe(zonedToUtcMs(TZ, addDaysToDateString(date, 1), '12:00'))
  })

  it('фикс-услуга занимает и тарифицирует k×базовых пакетов', async () => {
    seedMultiDb()
    const res = await demoBackend.createBooking(
      payload({ slug: SLUG2, kind: 'shoot', serviceId: 'svc-fixed', startUtcMs: zonedToUtcMs(TZ, weekdayDate(22), '10:00'), durationMin: 120 })
    )
    expect(res.ok).toBe(true)
    // 120 мин при базе 90 → k=2 → 10000×2
    expect(res.ok ? res.price?.total : 0).toBe(20000)
    const stored = JSON.parse(localStorage.getItem(`pf_demo_${SLUG2}`)!) as { bookings: { startsAtMs: number; endsAtMs: number }[] }
    const rec = stored.bookings.at(-1)!
    expect(rec.endsAtMs - rec.startsAtMs).toBe(180 * 60_000)
  })

  it('день-лимит специалиста действует и на день 2 многодневной брони', async () => {
    seedMultiDb()
    // подбираем дату, где s-lim свободен оба дня (многодневная с ним возможна),
    // а на день 2 у другого специалиста (s1) есть свободное время — контроль
    let multiStart = 0
    let controlStart = 0
    for (let off = 25; off < 140 && !multiStart; off++) {
      const d = weekdayDate(off)
      const d2 = addDaysToDateString(d, 1)
      const avMulti = await getAvail({ serviceId: 'svc-spec-fixed', dateFrom: d, dayCount: 2, durationMin: 60, specialistId: 's-lim' })
      const avControl = await getAvail({ serviceId: 'svc-spec-fixed', dateFrom: d2, durationMin: 60, specialistId: 's1' })
      if (avMulti.slots.length > 0 && avControl.slots.length > 0) {
        multiStart = avMulti.slots[0].startMs
        controlStart = avControl.slots[0].startMs
      }
    }
    expect(multiStart).toBeGreaterThan(0)
    // многодневная бронь со специалистом dayLimit=1 (специалист выбран явно)
    const multi = await demoBackend.createBooking(
      payload({ slug: SLUG2, kind: 'shoot', serviceId: 'svc-spec-fixed', startUtcMs: multiStart, dayCount: 2, durationMin: 60, specialistId: 's-lim' })
    )
    expect(multi.ok).toBe(true)
    // физически свободное время дня 2 с этим специалистом — закрыто:
    // день-лимит s-lim уже занят записью и на дату дня 2
    const again = await demoBackend.createBooking(
      payload({ slug: SLUG2, kind: 'shoot', serviceId: 'svc-spec-fixed', startUtcMs: controlStart, durationMin: 60, specialistId: 's-lim' })
    )
    expect(again.ok).toBe(false)
    // а другой специалист на то же время бронируется — отказ был именно из-за s-lim
    const other = await demoBackend.createBooking(
      payload({ slug: SLUG2, kind: 'shoot', serviceId: 'svc-spec-fixed', startUtcMs: controlStart, durationMin: 60, specialistId: 's1' })
    )
    expect(other.ok).toBe(true)
  })
})
