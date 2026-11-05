import type {
  AvailabilityQuery,
  Backend,
  BookingFilters,
  BookingRecord,
  StudioBundle,
} from './types'
import { STATUS_ACTIVE } from './types'
import { validateTenantConfig } from '@/core/schema'
import type { CreateBookingPayload } from '@/core/schema'
import { CONSENT_VERSION } from '@/lib/env'
import { computeAvailability, canCancelByPolicy, bookingBlockSpan } from '@/core/availability'
import { calculatePrice } from '@/core/price'
import type { BusyInterval } from '@/core/time'
import { zonedToUtcMs, utcToZonedDate } from '@/core/time'
import type { PortfolioItem, TenantSettings } from '@/core/types'

interface DemoDb {
  settings: TenantSettings
  specialists: StudioBundle['specialists']
  halls: StudioBundle['halls']
  services: StudioBundle['services']
  addons: StudioBundle['addons']
  portfolio: PortfolioItem[]
  bookings: BookingRecord[]
}

const key = (slug: string) => `pf_demo_${slug}`

function load(slug: string): DemoDb | null {
  const raw = localStorage.getItem(key(slug))
  return raw ? (JSON.parse(raw) as DemoDb) : null
}

function save(slug: string, db: DemoDb) {
  localStorage.setItem(key(slug), JSON.stringify(db))
}

async function seed(slug: string): Promise<DemoDb> {
  const res = await fetch(`/tenants/${slug}/tenant.json`)
  if (!res.ok) throw new Error(`Конфигурация студии «${slug}» не найдена`)
  const cfg = validateTenantConfig(await res.json())
  const db: DemoDb = {
    settings: cfg.settings,
    specialists: cfg.specialists,
    halls: cfg.halls,
    services: cfg.services,
    addons: cfg.addons,
    portfolio: cfg.portfolio,
    bookings: [],
  }
  save(slug, db)
  return db
}

async function withDb<T>(slug: string, fn: (db: DemoDb) => T | Promise<T>): Promise<T> {
  const db = load(slug) ?? (await seed(slug))
  const out = await fn(db)
  save(slug, db)
  return out
}

// Демонстрационная занятость: детерминирована по дате, чтобы образец всегда
// показывал и свободные, и занятые слоты. Только для demo-режима.
export function pseudoBusy(db: DemoDb, date: string): BusyInterval[] {
  const out: BusyInterval[] = []
  const d = new Date(date + 'T00:00:00Z')
  const dateSeed = d.getUTCDate() * 31 + (d.getUTCMonth() + 1) * 7 + d.getUTCDay()
  const resources: { type: 'specialist' | 'hall'; id: string }[] = [
    ...db.specialists.map((s) => ({ type: 'specialist' as const, id: s.id })),
    ...db.halls.map((h) => ({ type: 'hall' as const, id: h.id })),
  ]
  for (const r of resources) {
    let rid = 0
    for (const ch of r.id) rid += ch.charCodeAt(0)
    for (let hour = 9; hour < 22; hour++) {
      if ((dateSeed + rid + hour * 13) % 11 === 0) {
        const startMs = zonedToUtcMs(db.settings.tz, date, `${String(hour).padStart(2, '0')}:00`)
        out.push({ resourceType: r.type, resourceId: r.id, startMs, endMs: startMs + 2 * 3_600_000 })
        hour++
      }
    }
  }
  return out
}

function busyFor(db: DemoDb, q: AvailabilityQuery, dates: string[]): {
  busy: BusyInterval[]
  dayLimitBookings: { date: string; specialistId: string }[]
  fullDayBusy: { date: string; resourceType: 'specialist' | 'hall'; resourceId: string }[]
} {
  const busy: BusyInterval[] = dates.flatMap((d) => pseudoBusy(db, d))
  const dayLimitBookings: { date: string; specialistId: string }[] = []
  const fullDayBusy: { date: string; resourceType: 'specialist' | 'hall'; resourceId: string }[] = []
  for (const b of db.bookings) {
    if (STATUS_ACTIVE.includes(b.status) === false) continue
    const span = bookingBlockSpan(
      db.services.find((s) => s.id === b.serviceId) ?? {
        setupMin: 0,
        cleanupMin: 0,
      } as never,
      b.startsAtMs,
      (b.endsAtMs - b.startsAtMs) / 60_000,
      b.offsite,
      0,
      0
    )
    if (b.specialistId) busy.push({ resourceType: 'specialist', resourceId: b.specialistId, startMs: span.startMs, endMs: span.endMs })
    if (b.hallId) busy.push({ resourceType: 'hall', resourceId: b.hallId, startMs: span.startMs, endMs: span.endMs })
    if (b.allDay) {
      fullDayBusy.push({ date: utcToZonedDate(db.settings.tz, b.startsAtMs), resourceType: 'specialist', resourceId: b.specialistId ?? '' })
      if (b.hallId) fullDayBusy.push({ date: utcToZonedDate(db.settings.tz, b.startsAtMs), resourceType: 'hall', resourceId: b.hallId })
    }
    if (b.specialistId) dayLimitBookings.push({ date: utcToZonedDate(db.settings.tz, b.startsAtMs), specialistId: b.specialistId })
  }
  return { busy, dayLimitBookings, fullDayBusy }
}

const rid = () =>
  (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)) as string

export const demoBackend: Backend = {
  kind: 'demo',

  async loadStudio(slug) {
    const db = await withDb(slug, (d) => d)
    const absolutize = (src: string) =>
      /^(https?:|data:|\/)/.test(src) ? src : `/tenants/${slug}/${src.replace(/^\.?\//, '')}`
    return {
      settings: db.settings,
      specialists: db.specialists,
      halls: db.halls,
      services: db.services,
      addons: db.addons,
      portfolio: db.portfolio.map((p) => ({ ...p, src: absolutize(p.src) })),
    }
  },

  async getAvailability(q) {
    return withDb(q.slug, (db) => {
      const service = db.services.find((s) => s.id === q.serviceId)
      if (!service) return []
      const { busy, dayLimitBookings, fullDayBusy } = busyFor(db, q, [q.dateFrom])
      const zone = db.settings.travelZones.find((z) => z.id === q.travelZoneId)
      const { slots } = computeAvailability({
        tz: db.settings.tz,
        schedule: db.settings.schedule,
        closedDates: db.settings.closedDates,
        dateFrom: q.dateFrom,
        service,
        specialistId: q.specialistId ?? null,
        hallId: q.hallId ?? null,
        specialists: db.specialists,
        halls: db.halls,
        busy,
        dayLimitBookings,
        fullDayBusy,
        offsite: q.offsite,
        travelBeforeMin: q.offsite ? (zone?.minutesBefore ?? 0) : 0,
        travelAfterMin: q.offsite ? (zone?.minutesAfter ?? 0) : 0,
        durationMin: q.durationMin,
        dayCount: q.dayCount,
        peopleCount: q.peopleCount,
        nowMs: Date.now(),
      })
      return slots
    })
  },

  async createBooking(payload) {
    return withDb(payload.slug, (db) => {
      if (payload.honeypot) return { ok: false as const, error: 'Заявка отклонена' }
      const service = db.services.find((s) => s.id === payload.serviceId)
      if (!service) return { ok: false as const, error: 'Услуга не найдена' }
      const conflict = db.bookings.some(
        (b) =>
          STATUS_ACTIVE.includes(b.status) &&
          b.startsAtMs < payload.startUtcMs + (payload.durationMin ?? service.durationMin) * 60_000 &&
          payload.startUtcMs < b.endsAtMs &&
          ((b.specialistId && payload.specialistId === b.specialistId) ||
            (b.hallId && payload.hallId === b.hallId))
      )
      if (conflict) return { ok: false as const, error: 'Это время только что заняли. Выберите другое' }
      const token = rid()
      const zone = db.settings.travelZones.find((z) => z.id === payload.travelZoneId) ?? null
      const hall = db.halls.find((h) => h.id === payload.hallId) ?? null
      const price = calculatePrice({
        service,
        hall,
        tz: db.settings.tz,
        startUtcMs: payload.startUtcMs,
        durationMin: payload.durationMin,
        peopleCount: payload.peopleCount,
        selectedAddonIds: payload.addonIds ?? [],
        addons: db.addons,
        travelZone: payload.offsite ? zone : null,
        eveningFrom: db.settings.eveningFrom,
      })
      const record: BookingRecord = {
        id: rid(),
        slug: payload.slug,
        kind: payload.kind,
        serviceId: service.id,
        serviceName: service.name,
        specialistId: payload.specialistId ?? null,
        hallId: payload.hallId ?? null,
        startsAtMs: payload.startUtcMs,
        endsAtMs: payload.startUtcMs + (payload.durationMin ?? service.durationMin) * 60_000,
        allDay: service.fullDay,
        dayCount: payload.dayCount ?? 1,
        status: service.autoConfirm ? 'confirmed' : 'new',
        client: payload.client,
        price,
        paidTotal: 0,
        token,
        createdAtMs: Date.now(),
        source: 'web',
        offsite: Boolean(payload.offsite),
        travelZoneId: payload.travelZoneId ?? null,
        consent: { version: CONSENT_VERSION, atMs: Date.now() },
      }
      db.bookings.push(record)
      return { ok: true as const, token }
    })
  },

  async getMyBooking(slug, token) {
    const db = load(slug) ?? (await seed(slug))
    return db.bookings.find((b) => b.token === token) ?? null
  },

  async cancelMyBooking(slug, token) {
    return withDb(slug, (db) => {
      const b = db.bookings.find((x) => x.token === token)
      if (!b) return { ok: false, error: 'Запись не найдена' }
      const can = canCancelByPolicy({
        startsAtMs: b.startsAtMs,
        freeHours: db.settings.cancellation.freeHours,
        nowMs: Date.now(),
        status: b.status,
      })
      if (!can.allowed) return { ok: false, error: can.reason }
      b.status = 'cancelled_by_client'
      return { ok: true }
    })
  },

  async requestAssistant(_slug, _message, _kind) {
    return {
      reply:
        'Демо-режим: помощник подключается вместе с Supabase и ключом модели в переменных окружения. А пока смотрите услуги и свободное время на странице записи.',
      unavailable: true,
    }
  },

  async ownerSignIn(email) {
    await new Promise((r) => setTimeout(r, 400))
    if (!email.includes('@')) throw new Error('Введите корректный email')
    localStorage.setItem('pf_demo_owner', email)
  },

  async ownerSignOut() {
    localStorage.removeItem('pf_demo_owner')
  },

  ownerOnAuthChange(cb) {
    cb(Boolean(localStorage.getItem('pf_demo_owner')))
  },

  async ownerBookings(slug, filters) {
    const db = load(slug) ?? (await seed(slug))
    let list = [...db.bookings]
    if (filters?.status && filters.status !== 'all') {
      list =
        filters.status === 'active'
          ? list.filter((b) => STATUS_ACTIVE.includes(b.status))
          : list.filter((b) => b.status === filters.status)
    }
    if (filters?.specialistId) list = list.filter((b) => b.specialistId === filters.specialistId)
    if (filters?.hallId) list = list.filter((b) => b.hallId === filters.hallId)
    if (filters?.dateFrom) list = list.filter((b) => utcToZonedDate(db.settings.tz, b.startsAtMs) >= filters.dateFrom!)
    if (filters?.dateTo) list = list.filter((b) => utcToZonedDate(db.settings.tz, b.startsAtMs) <= filters.dateTo!)
    return list.sort((a, b) => a.startsAtMs - b.startsAtMs)
  },

  async ownerUpdateBooking(slug, id, patch) {
    await withDb(slug, (db) => {
      const b = db.bookings.find((x) => x.id === id)
      if (b) Object.assign(b, patch)
    })
  },

  async ownerCreateBookingManual(slug, record) {
    await withDb(slug, (db) => {
      db.bookings.push({ ...record, id: rid(), token: rid(), createdAtMs: Date.now(), source: 'manual' })
    })
  },

  async ownerSaveSettings(slug, settings) {
    await withDb(slug, (db) => {
      db.settings = settings
    })
  },

  async ownerUpsertSpecialist(slug, item) {
    await withDb(slug, (db) => {
      const i = db.specialists.findIndex((x) => x.id === item.id)
      if (i >= 0) db.specialists[i] = item
      else db.specialists.push(item)
    })
  },

  async ownerUpsertHall(slug, item) {
    await withDb(slug, (db) => {
      const i = db.halls.findIndex((x) => x.id === item.id)
      if (i >= 0) db.halls[i] = item
      else db.halls.push(item)
    })
  },

  async ownerUpsertService(slug, item) {
    await withDb(slug, (db) => {
      const i = db.services.findIndex((x) => x.id === item.id)
      if (i >= 0) db.services[i] = item
      else db.services.push(item)
    })
  },

  async ownerDeleteService(slug, id) {
    await withDb(slug, (db) => {
      db.services = db.services.filter((x) => x.id !== id)
    })
  },

  async ownerUpsertAddon(slug, item) {
    await withDb(slug, (db) => {
      const i = db.addons.findIndex((x) => x.id === item.id)
      if (i >= 0) db.addons[i] = item
      else db.addons.push(item)
    })
  },

  async ownerDeleteAddon(slug, id) {
    await withDb(slug, (db) => {
      db.addons = db.addons.filter((x) => x.id !== id)
    })
  },

  async ownerAnonymizeClient(slug, bookingId) {
    await withDb(slug, (db) => {
      const b = db.bookings.find((x) => x.id === bookingId)
      if (b) {
        b.client = { ...b.client, name: 'Данные удалены', phone: 'удалено', notes: undefined }
      }
    })
  },

  async ownerUploadPortfolioPhoto(_slug, file) {
    const { compressImage, blobToDataUrl } = await import('@/lib/image')
    const { variants } = await compressImage(file)
    const src = await blobToDataUrl(variants[640])
    return { src }
  },

  async ownerCalendarToken(_slug) {
    return null
  },

  async ownerUpsertPortfolioItem(slug, item) {
    await withDb(slug, (db) => {
      const i = db.portfolio.findIndex((p) => p.id === item.id)
      if (i >= 0) db.portfolio[i] = item
      else db.portfolio.push(item)
      db.portfolio.sort((a, b) => a.sort - b.sort)
    })
  },

  async ownerDeletePortfolioItem(slug, id) {
    await withDb(slug, (db) => {
      db.portfolio = db.portfolio.filter((p) => p.id !== id)
    })
  },
}
