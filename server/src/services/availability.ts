import { computeAvailability } from '../../../src/core/availability'
import type { BusyInterval, BusyResourceType } from '../../../src/core/time'
import { utcToZonedDate, zonedToUtcMs } from '../../../src/core/time'
import type { Hall, Service, Specialist, TenantSettings } from '../../../src/core/types'
import { query } from '../db'

const ACTIVE_STATUSES = ['new', 'confirmed', 'prepaid', 'shot_done', 'processing', 'delivered']

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface BusyData {
  busy: BusyInterval[]
  dayLimitBookings: { date: string; specialistId: string }[]
}

// Занятость: интервалы броней (с буферами), закрытые периоды, лимиты дня.
// Единственный источник занятости — busy-интервалы из booking_resources/
// closed_periods; полнодневность покрыта целодневными интервалами ресурсов.
// excludeBookingId — валидация переноса: не учитывать саму бронь, иначе её
// текущие блокировки мешают её же новому времени.
export async function loadBusy(
  studioId: string,
  specialists: Specialist[],
  halls: Hall[],
  tz: string,
  excludeBookingId?: string,
  // P1: интересующий диапазон UTC-мс; отсутствует = старое поведение (всё)
  rangeFromMs?: number,
  rangeToMs?: number
): Promise<BusyData> {
  const out: BusyData = { busy: [], dayLimitBookings: [] }
  // запас ±1 день: буферы/полные дни могут выступать за границы расчёта
  const from = rangeFromMs !== undefined ? new Date(rangeFromMs - 86_400_000) : null
  const to = rangeToMs !== undefined ? new Date(rangeToMs + 86_400_000) : null

  const res = await query<{
    resource_type: string
    resource_id: string
    lo: Date
    hi: Date
  }>(
    `select resource_type, resource_id, lower(during) as lo, upper(during) as hi
     from booking_resources where studio_id = $1 and ($2::text is null or booking_id <> $2)
       and ($3::timestamptz is null or during && tstzrange($3::timestamptz, $4::timestamptz))`,
    [studioId, excludeBookingId ?? null, from, to]
  )
  for (const r of res.rows) {
    out.busy.push({
      resourceType: r.resource_type as BusyResourceType,
      resourceId: r.resource_id,
      startMs: new Date(r.lo).getTime(),
      endMs: new Date(r.hi).getTime(),
    })
  }

  const closed = await query<{
    resource_type: string | null
    resource_id: string | null
    lo: Date
    hi: Date
  }>(
    `select resource_type, resource_id, lower(during) as lo, upper(during) as hi
     from closed_periods where studio_id = $1
       and ($2::timestamptz is null or during && tstzrange($2::timestamptz, $3::timestamptz))`,
    [studioId, from, to]
  )
  for (const r of closed.rows) {
    const span = { startMs: new Date(r.lo).getTime(), endMs: new Date(r.hi).getTime() }
    if (r.resource_type && r.resource_id) {
      out.busy.push({ resourceType: r.resource_type as BusyResourceType, resourceId: r.resource_id, ...span })
    } else {
      for (const s of specialists) out.busy.push({ resourceType: 'specialist', resourceId: s.id, ...span })
      for (const h of halls) out.busy.push({ resourceType: 'hall', resourceId: h.id, ...span })
    }
  }

  const bookings = await query<{
    specialist_id: string | null
    specialist_ids: string[] | null
    starts_at: Date
    day_count: number
  }>(
    `select specialist_id, specialist_ids, starts_at, day_count from bookings
     where studio_id = $1 and status = any($2) and ($3::text is null or id <> $3)
       and ($4::timestamptz is null or starts_at + make_interval(days => greatest(day_count,1)) >= $4)
       and ($5::timestamptz is null or starts_at <= $5)`,
    [studioId, ACTIVE_STATUSES, excludeBookingId ?? null, from, to]
  )
  for (const b of bookings.rows) {
    const ids = b.specialist_ids?.length ? b.specialist_ids : b.specialist_id ? [b.specialist_id] : []
    // многодневная бронь съедает лимит каждого своего дня, а не только дату старта
    const startDate = utcToZonedDate(tz, new Date(b.starts_at).getTime())
    for (let i = 0; i < Math.max(1, b.day_count ?? 1); i++) {
      const date = addDays(startDate, i)
      for (const specialistId of ids) out.dayLimitBookings.push({ date, specialistId })
    }
  }

  return out
}

export interface AvailabilityInput {
  studioId: string
  settings: TenantSettings
  specialists: Specialist[]
  halls: Hall[]
  services: Service[]
  serviceId: string
  dateFrom: string
  dayCount?: number
  durationMin?: number
  specialistId: string | null
  hallId: string | null
  offsite: boolean
  travelZoneId: string | null
  peopleCount?: number
  // валидация переноса брони: исключить её собственные блокировки/лимиты
  excludeBookingId?: string
}

export async function getSlots(input: AvailabilityInput): Promise<{
  slots: { startMs: number; specialistId: string | null; specialistIds?: string[] }[]
  reason?: string
}> {
  const service = input.services.find((s) => s.id === input.serviceId)
  if (!service) return { slots: [], reason: 'Услуга не найдена' }
  const zone = input.settings.travelZones.find((z) => z.id === input.travelZoneId)

  // Белый список специалистов услуги: пусто/undefined — любой активный.
  // Фильтруем СНАЧАЛА: и «любой свободный», и явно выбранный ищутся только среди них.
  const allowedSpecialists = input.specialists.filter(
    (s) => s.active && (!service.specialistIds?.length || service.specialistIds.includes(s.id))
  )
  if (input.specialistId && !allowedSpecialists.some((s) => s.id === input.specialistId)) {
    return { slots: [], reason: 'Специалист недоступен для этой услуги' }
  }

  // P1: загружаем только окно дат расчёта (+ запас), а не всю историю студии
  const days = Math.max(1, input.dayCount ?? 1)
  const rangeFromMs = zonedToUtcMs(input.settings.tz, input.dateFrom, '00:00') - 86_400_000
  const rangeToMs = rangeFromMs + (days + 2) * 86_400_000
  const { busy, dayLimitBookings } = await loadBusy(
    input.studioId,
    input.specialists,
    input.halls,
    input.settings.tz,
    input.excludeBookingId,
    rangeFromMs,
    rangeToMs
  )

  // Белый список залов услуги (hallIds пусто/undefined — любые активные)
  const allowedHalls = input.halls.filter(
    (h) => h.active && (!service.hallIds?.length || service.hallIds.includes(h.id))
  )
  const needsHall = service.needsHall || service.kind === 'rental'
  const chosen = input.hallId ? allowedHalls.find((h) => h.id === input.hallId) : null
  if (input.hallId && !chosen) return { slots: [], reason: 'Зал недоступен для этой услуги' }
  if (needsHall && !chosen && allowedHalls.length === 0) {
    return { slots: [], reason: 'Для услуги не осталось доступных залов' }
  }

  const common = {
    tz: input.settings.tz,
    schedule: input.settings.schedule,
    closedDates: input.settings.closedDates,
    dateFrom: input.dateFrom,
    service,
    specialistId: input.specialistId ?? null,
    specialists: allowedSpecialists,
    busy,
    dayLimitBookings,
    offsite: input.offsite,
    travelBeforeMin: input.offsite ? (zone?.minutesBefore ?? 0) : 0,
    travelAfterMin: input.offsite ? (zone?.minutesAfter ?? 0) : 0,
    durationMin: input.durationMin,
    dayCount: input.dayCount,
    peopleCount: input.peopleCount,
    nowMs: Date.now(),
  }

  // Авто-режим (зал не выбран): время свободно, если свободен хотя бы один
  // разрешённый зал. Конкретный зал выберется при создании брони.
  if (needsHall && !chosen) {
    const merged = new Map<number, { startMs: number; specialistId: string | null; specialistIds?: string[] }>()
    for (const hall of allowedHalls) {
      const r = computeAvailability({ ...common, halls: [hall], hallId: hall.id })
      for (const s of r.slots) if (!merged.has(s.startMs)) merged.set(s.startMs, s)
    }
    return {
      slots: [...merged.values()].sort((a, b) => a.startMs - b.startMs),
    }
  }

  return computeAvailability({
    ...common,
    halls: chosen ? [chosen] : input.halls,
    hallId: input.hallId ?? null,
  })
}
