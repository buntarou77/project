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
import { buildFullDayWindows, calculatePrice } from '@/core/price'
import type { BusyInterval } from '@/core/time'
import { addDaysToDateString, zonedToUtcMs, utcToZonedDate } from '@/core/time'
import type { PortfolioItem, ClosedPeriod, TenantSettings } from '@/core/types'

interface DemoDb {
  settings: TenantSettings
  specialists: StudioBundle['specialists']
  halls: StudioBundle['halls']
  services: StudioBundle['services']
  addons: StudioBundle['addons']
  portfolio: PortfolioItem[]
  bookings: BookingRecord[]
  closedPeriods?: ClosedPeriod[]
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
} {
  const busy: BusyInterval[] = dates.flatMap((d) => pseudoBusy(db, d))
  // закрытые периоды: отпуск специалиста / закрытие зала / всей студии
  for (const cp of db.closedPeriods ?? []) {
    for (const d of dates) {
      if (d < cp.dateFrom || d > cp.dateTo) continue
      const startMs = zonedToUtcMs(db.settings.tz, d, '00:00')
      const endMs = startMs + 24 * 3_600_000
      if (cp.resourceType === 'specialist' && cp.resourceId) {
        busy.push({ resourceType: 'specialist', resourceId: cp.resourceId, startMs, endMs })
      } else if (cp.resourceType === 'hall' && cp.resourceId) {
        busy.push({ resourceType: 'hall', resourceId: cp.resourceId, startMs, endMs })
      } else {
        for (const s of db.specialists) busy.push({ resourceType: 'specialist', resourceId: s.id, startMs, endMs })
        for (const h of db.halls) busy.push({ resourceType: 'hall', resourceId: h.id, startMs, endMs })
      }
    }
  }
  const dayLimitBookings: { date: string; specialistId: string }[] = []
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
    if (b.specialistId) {
      // день-лимит съедает каждый день многодневной брони, не только дату старта
      const startDate = utcToZonedDate(db.settings.tz, b.startsAtMs)
      for (let i = 0; i < Math.max(1, b.dayCount ?? 1); i++) {
        dayLimitBookings.push({ date: addDaysToDateString(startDate, i), specialistId: b.specialistId })
      }
    }
  }
  return { busy, dayLimitBookings }
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
      halls: db.halls.map((h) => ({ ...h, photos: (h.photos ?? []).map(absolutize) })),
      services: db.services,
      addons: db.addons,
      portfolio: db.portfolio.map((p) => ({ ...p, src: absolutize(p.src) })),
    }
  },

  async getAvailability(q) {
    return withDb(q.slug, (db) => {
      const service = db.services.find((s) => s.id === q.serviceId)
      if (!service) return { slots: [], reason: 'Услуга не найдена' }
      // занятость нужна по всем дням многодневного запроса, не только по первому
      const dates: string[] = []
      for (let i = 0; i < (q.dayCount ?? 1); i++) dates.push(addDaysToDateString(q.dateFrom, i))
      const { busy, dayLimitBookings } = busyFor(db, q, dates)
      const zone = db.settings.travelZones.find((z) => z.id === q.travelZoneId)
      // белый список специалистов услуги — как в боевом availability
      const allowedSpecs = service.specialistIds?.length
        ? db.specialists.filter((s) => service.specialistIds!.includes(s.id))
        : db.specialists
      // белый список залов услуги — сервер зал вне списка не принимает
      const allowedHalls = service.hallIds?.length
        ? db.halls.filter((h) => service.hallIds!.includes(h.id))
        : db.halls
      const common = {
        tz: db.settings.tz,
        schedule: db.settings.schedule,
        closedDates: db.settings.closedDates,
        dateFrom: q.dateFrom,
        service,
        specialistId: q.specialistId ?? null,
        specialists: allowedSpecs,
        busy,
        dayLimitBookings,
        offsite: q.offsite,
        travelBeforeMin: q.offsite ? (zone?.minutesBefore ?? 0) : 0,
        travelAfterMin: q.offsite ? (zone?.minutesAfter ?? 0) : 0,
        durationMin: q.durationMin,
        dayCount: q.dayCount,
        peopleCount: q.peopleCount,
        nowMs: Date.now(),
      }
      // авто-режим зала (выбор скрыт/не сделан): как боевой getSlots — время
      // свободно, если свободен хотя бы один разрешённый зал; конкретный зал
      // выберется при создании брони
      if (service.needsHall && !q.hallId) {
        if (allowedHalls.filter((h) => h.active).length === 0) {
          return { slots: [], reason: 'Для услуги не осталось доступных залов' }
        }
        const merged = new Map<number, string | null>()
        for (const hall of allowedHalls) {
          const r = computeAvailability({ ...common, halls: [hall], hallId: hall.id })
          for (const s of r.slots) if (!merged.has(s.startMs)) merged.set(s.startMs, s.specialistId)
        }
        return {
          slots: [...merged.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([startMs, specialistId]) => ({ startMs, specialistId })),
        }
      }
      const { slots, reason } = computeAvailability({
        ...common,
        hallId: q.hallId ?? null,
        halls: allowedHalls,
      })
      return { slots, reason }
    })
  },

  async createBooking(payload) {
    return withDb(payload.slug, (db) => {
      if (payload.honeypot) return { ok: false as const, error: 'Заявка отклонена' }
      const service = db.services.find((s) => s.id === payload.serviceId)
      if (!service) return { ok: false as const, error: 'Услуга не найдена' }
      if (service.maxPeople && (payload.peopleCount ?? 1) > service.maxPeople) {
        return { ok: false as const, error: `Максимум людей для этой услуги — ${service.maxPeople}` }
      }
      const zone = db.settings.travelZones.find((z) => z.id === payload.travelZoneId) ?? null
      const offsite = Boolean(payload.offsite)
      // почасовая услуга занимает зал всегда — даже без галки needsHall
      const needHall = service.needsHall || service.priceType === 'hourly'
      const dayCount = service.multiDayMax > 1 ? Math.min(service.multiDayMax, payload.dayCount ?? 1) : 1
      // окна всех дней нужны не только «всему дню», но и многодневной не-fullDay:
      // по ним считаются занятость (starts/ends) и почасовая цена
      const fdw = service.fullDay || dayCount > 1
        ? buildFullDayWindows(db.settings.schedule, db.settings.tz, payload.startUtcMs, dayCount)
        : null
      const durationMin = payload.durationMin ?? service.durationMin
      // фикс-услуга занимает целое число базовых пакетов: k×базы минут
      const fixed = service.priceType === 'fixed'
      const k = Math.max(1, Math.ceil(durationMin / service.durationMin))
      const endsAtMs = fdw
        ? fdw.lastCloseMs
        : payload.startUtcMs + (fixed ? k * service.durationMin : durationMin) * 60_000
      const dateFrom = utcToZonedDate(db.settings.tz, payload.startUtcMs)
      const dates: string[] = []
      for (let i = 0; i < dayCount; i++) dates.push(addDaysToDateString(dateFrom, i))
      const { busy, dayLimitBookings } = busyFor(
        db,
        {
          slug: payload.slug,
          serviceId: service.id,
          dateFrom,
          dayCount,
          specialistId: payload.specialistId ?? null,
          hallId: payload.hallId ?? null,
          offsite,
          travelZoneId: payload.travelZoneId ?? null,
          peopleCount: payload.peopleCount,
        },
        dates
      )
      // белый список специалистов/залов услуги — как в боевом availability
      const allowedSpecs = service.specialistIds?.length
        ? db.specialists.filter((s) => service.specialistIds!.includes(s.id))
        : db.specialists
      const allowedHalls = service.hallIds?.length
        ? db.halls.filter((h) => service.hallIds!.includes(h.id) && h.active)
        : db.halls.filter((h) => h.active)
      const common = {
        tz: db.settings.tz,
        schedule: db.settings.schedule,
        closedDates: db.settings.closedDates,
        dateFrom,
        service,
        specialists: allowedSpecs,
        busy,
        dayLimitBookings,
        offsite,
        travelBeforeMin: offsite ? (zone?.minutesBefore ?? 0) : 0,
        travelAfterMin: offsite ? (zone?.minutesAfter ?? 0) : 0,
        durationMin,
        dayCount,
        peopleCount: payload.peopleCount,
        nowMs: Date.now(),
      }
      // Зеркалим боевой createPublicBooking: «любой свободный» зал/специалист
      // подбирается здесь, конфликт ресурсов решает ядро (в бою — EXCLUDE-констрейнт)
      let hall = needHall && payload.hallId
        ? allowedHalls.find((h) => h.id === payload.hallId) ?? null
        : null
      if (needHall && payload.hallId && !hall) {
        return { ok: false as const, error: 'Зал недоступен для этой услуги' }
      }
      if (needHall && !hall) {
        for (const cand of allowedHalls) {
          const { slots } = computeAvailability({ ...common, halls: [cand], hallId: cand.id, specialistId: null })
          if (slots.some((s) => s.startMs === payload.startUtcMs)) {
            hall = cand
            break
          }
        }
        if (!hall) return { ok: false as const, error: 'Свободного зала на это время нет' }
      }
      let specialistId = payload.specialistId ?? null
      if (service.needsSpecialist && !specialistId) {
        const { slots } = computeAvailability({
          ...common,
          halls: hall ? [hall] : [],
          hallId: hall?.id ?? null,
          specialistId: null,
        })
        const match = slots.find((s) => s.startMs === payload.startUtcMs)
        if (!match?.specialistId) {
          return { ok: false as const, error: 'Свободного специалиста на это время нет' }
        }
        specialistId = match.specialistId
      } else if (hall || specialistId) {
        // явно выбранные зал/специалист: время тоже должно быть свободно по ядру
        const { slots } = computeAvailability({
          ...common,
          halls: hall ? [hall] : [],
          hallId: hall?.id ?? null,
          specialistId,
        })
        if (!slots.some((s) => s.startMs === payload.startUtcMs)) {
          return { ok: false as const, error: 'Это время только что заняли. Выберите другое' }
        }
      }
      const token = rid()
      const spObj = specialistId
        ? db.specialists.find((x) => x.id === specialistId) ?? null
        : null
      const price = calculatePrice({
        service,
        hall,
        tz: db.settings.tz,
        startUtcMs: payload.startUtcMs,
        // «весь день» фикс-пакета: без durationMin — цена × дней, без кратности
        durationMin: service.fullDay && fixed ? undefined : durationMin,
        fullDayWindows: fdw?.windows,
        // многодневная почасовая: тарифицируем часы/день в каждом окне, а не всё окно
        hoursPerDay: fdw && !service.fullDay && !fixed ? Math.max(1, Math.ceil(durationMin / 60)) : undefined,
        specialist: spObj?.hourRate ? { name: spObj.name, hourRate: spObj.hourRate } : null,
        peopleCount: payload.peopleCount,
        selectedAddonIds: payload.addonIds ?? [],
        addons: db.addons,
        travelZone: offsite ? zone : null,
        eveningFrom: db.settings.eveningFrom,
      })
      const record: BookingRecord = {
        id: rid(),
        slug: payload.slug,
        kind: payload.kind,
        serviceId: service.id,
        serviceName: service.name,
        specialistId,
        hallId: needHall ? hall?.id ?? null : null,
        startsAtMs: payload.startUtcMs,
        endsAtMs,
        allDay: service.fullDay,
        dayCount: payload.dayCount ?? 1,
        status: service.autoConfirm ? 'confirmed' : 'new',
        client: payload.client,
        price,
        paidTotal: 0,
        token,
        createdAtMs: Date.now(),
        source: 'web',
        offsite,
        travelZoneId: payload.travelZoneId ?? null,
        consent: { version: CONSENT_VERSION, atMs: Date.now() },
      }
      db.bookings.push(record)
      return { ok: true as const, token, price }
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

  async ownerDeleteSpecialist(slug, id) {
    await withDb(slug, (db) => {
      db.specialists = db.specialists.filter((x) => x.id !== id)
    })
  },

  // В демо фото храним dataURL прямо в localStorage (сжатие на устройстве)
  async ownerUploadSpecialistPhoto(_slug, file) {
    const src = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('Не удалось прочитать файл'))
      r.readAsDataURL(file)
    })
    return { src }
  },

  async ownerUpsertHall(slug, item) {
    await withDb(slug, (db) => {
      const i = db.halls.findIndex((x) => x.id === item.id)
      if (i >= 0) db.halls[i] = item
      else db.halls.push(item)
    })
  },

  async ownerDeleteHall(slug, id) {
    await withDb(slug, (db) => {
      db.halls = db.halls.filter((x) => x.id !== id)
      // чистим белые списки услуг, как это делает боевой сервер
      for (const s of db.services) {
        if (s.hallIds) s.hallIds = s.hallIds.filter((x) => x !== id)
      }
    })
  },

  // В демо фото залов тоже храним dataURL в localStorage (сжатие на устройстве)
  async ownerUploadHallPhoto(_slug, file) {
    const src = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('Не удалось прочитать файл'))
      r.readAsDataURL(file)
    })
    return { src }
  },

  async ownerUploadServicePhoto(_slug, file) {
    const src = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('Не удалось прочитать файл'))
      r.readAsDataURL(file)
    })
    return { src }
  },

  // ---------- закрытые периоды (демо: localStorage) ----------

  async ownerClosedPeriods(slug) {
    return withDb(slug, (db) => db.closedPeriods ?? [])
  },

  async ownerUpsertClosedPeriod(slug, item) {
    const out = await withDb(slug, (db) => {
      const list = db.closedPeriods ?? []
      const i = list.findIndex((x) => x.id === item.id)
      if (i >= 0) list[i] = item
      else list.push(item)
      db.closedPeriods = list
      // паритет с сервером: активные брони, пересекающие период
      // (специалист/зал/вся студия; строгое пересечение по датам периода)
      const startMs = zonedToUtcMs(db.settings.tz, item.dateFrom, '00:00')
      const endMs = zonedToUtcMs(db.settings.tz, addDaysToDateString(item.dateTo, 1), '00:00') - 1
      const conflicts = db.bookings
        .filter(
          (b) =>
            STATUS_ACTIVE.includes(b.status) &&
            b.startsAtMs < endMs &&
            b.endsAtMs > startMs &&
            (item.resourceType === 'specialist'
              ? Boolean(item.resourceId) && b.specialistId === item.resourceId
              : item.resourceType === 'hall'
                ? Boolean(item.resourceId) && b.hallId === item.resourceId
                : true)
        )
        .map((b) => ({ id: b.id, serviceName: b.serviceName, clientName: b.client.name, startsAtMs: b.startsAtMs }))
      return { conflicts }
    })
    return out
  },

  async ownerDeleteClosedPeriod(slug, id) {
    await withDb(slug, (db) => {
      db.closedPeriods = (db.closedPeriods ?? []).filter((x) => x.id !== id)
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
