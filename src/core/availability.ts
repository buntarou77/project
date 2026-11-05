import type { Hall, Service, Specialist, WeekSchedule } from './types'
import {
  addDaysToDateString,
  type BusyInterval,
  type BusyResourceType,
  overlaps,
  utcToZonedDate,
  weekdayKeyOfDate,
  zonedToUtcMs,
} from './time'

export interface AvailabilityInput {
  tz: string
  schedule: WeekSchedule
  closedDates: string[]
  dateFrom: string
  service: Service
  specialistId: string | null
  hallId: string | null
  specialists: Specialist[]
  halls: Hall[]
  busy: BusyInterval[]
  dayLimitBookings: { date: string; specialistId: string }[]
  fullDayBusy: { date: string; resourceType: BusyResourceType; resourceId: string }[]
  offsite: boolean
  travelBeforeMin: number
  travelAfterMin: number
  durationMin?: number
  dayCount?: number
  stepMin?: number
  peopleCount?: number
  nowMs?: number
}

export interface FreeSlot {
  startMs: number
  specialistId: string | null
}

export interface AvailabilityResult {
  slots: FreeSlot[]
  reason?: string
}

export function bookingBlockSpan(
  service: Service,
  startMs: number,
  durationMin: number,
  offsite: boolean,
  travelBeforeMin: number,
  travelAfterMin: number
): { startMs: number; endMs: number } {
  const before = service.setupMin + (offsite ? travelBeforeMin : 0)
  const after = service.cleanupMin + (offsite ? travelAfterMin : 0)
  return { startMs: startMs - before * 60_000, endMs: startMs + durationMin * 60_000 + after * 60_000 }
}

function isDateOpen(schedule: WeekSchedule, closedDates: string[], date: string): boolean {
  if (closedDates.includes(date)) return false
  const key = weekdayKeyOfDate(date)
  return schedule[key] !== null
}

function windowFor(schedule: WeekSchedule, date: string): { open: string; close: string } | null {
  const key = weekdayKeyOfDate(date)
  return schedule[key]
}

function specialistDayCount(input: AvailabilityInput, specialistId: string, date: string): number {
  return input.dayLimitBookings.filter((b) => b.specialistId === specialistId && b.date === date).length
}

function isFullDayBusy(input: AvailabilityInput, type: BusyResourceType, id: string, date: string): boolean {
  return input.fullDayBusy.some((b) => b.resourceType === type && b.resourceId === id && b.date === date)
}

function resourceFree(input: AvailabilityInput, type: BusyResourceType, id: string, startMs: number, endMs: number): boolean {
  return !input.busy.some((b) => b.resourceType === type && b.resourceId === id && overlaps(b.startMs, b.endMs, startMs, endMs))
}

function coveredDates(tz: string, startMs: number, endMs: number): string[] {
  const dates: string[] = []
  let cursor = startMs
  let guard = 0
  while (cursor <= endMs && guard < 60) {
    const d = utcToZonedDate(tz, cursor)
    if (!dates.includes(d)) dates.push(d)
    cursor += 12 * 3_600_000
    guard++
  }
  const last = utcToZonedDate(tz, endMs)
  if (!dates.includes(last)) dates.push(last)
  return dates
}

function specialistFreeForSpan(
  input: AvailabilityInput,
  s: Specialist,
  span: { startMs: number; endMs: number },
  dates: string[]
): boolean {
  for (const date of dates) {
    if (input.service.fullDay && isFullDayBusy(input, 'specialist', s.id, date)) return false
    if (specialistDayCount(input, s.id, date) >= s.dayLimit) return false
  }
  return resourceFree(input, 'specialist', s.id, span.startMs, span.endMs)
}

function hallFreeForSpan(
  input: AvailabilityInput,
  hall: Hall,
  span: { startMs: number; endMs: number },
  dates: string[],
  peopleCount?: number
): boolean {
  if (peopleCount && peopleCount > hall.capacity) return false
  for (const date of dates) {
    if (input.service.fullDay && isFullDayBusy(input, 'hall', hall.id, date)) return false
  }
  return resourceFree(input, 'hall', hall.id, span.startMs, span.endMs)
}

export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const { service, tz } = input
  const durationMin = input.durationMin ?? service.durationMin
  const stepMin = input.stepMin ?? 30
  const dayCount = service.fullDay ? 1 : (input.dayCount ?? 1)
  const nowMs = input.nowMs

  const activeSpecialists = input.specialists.filter((s) => s.active)
  const activeHalls = input.halls.filter((h) => h.active)

  const hall = input.hallId ? activeHalls.find((h) => h.id === input.hallId) : null
  if (input.hallId && !hall) return { slots: [], reason: 'Зал недоступен' }
  if (service.needsHall && !hall) return { slots: [], reason: 'Выберите зал' }
  const chosenSpecialist = input.specialistId ? activeSpecialists.find((s) => s.id === input.specialistId) : null
  if (input.specialistId && !chosenSpecialist) return { slots: [], reason: 'Специалист недоступен' }

  const dates: string[] = []
  for (let i = 0; i < dayCount; i++) dates.push(addDaysToDateString(input.dateFrom, i))
  for (const d of dates) {
    if (!isDateOpen(input.schedule, input.closedDates, d)) return { slots: [], reason: `Дата ${d} закрыта` }
  }

  const firstWin = windowFor(input.schedule, dates[0])!
  const openMs = zonedToUtcMs(tz, dates[0], firstWin.open)
  const closeMs = zonedToUtcMs(tz, dates[0], firstWin.close)

  const candidates: number[] = []
  if (service.fullDay) {
    candidates.push(openMs)
  } else if (dayCount > 1) {
    candidates.push(openMs)
  } else {
    const tail = durationMin * 60_000 + service.cleanupMin * 60_000 + (input.offsite ? input.travelAfterMin * 60_000 : 0)
    for (let t = openMs; t + tail <= closeMs; t += stepMin * 60_000) {
      if (nowMs !== undefined && t < nowMs) continue
      candidates.push(t)
    }
  }

  const slots: FreeSlot[] = []
  for (const startMs of candidates) {
    const span = bookingBlockSpan(
      service,
      startMs,
      service.fullDay && dayCount === 1 ? durationMin : durationMin * dayCount,
      input.offsite,
      input.travelBeforeMin,
      input.travelAfterMin
    )
    if (service.fullDay) {
      // полный день блокирует окна каждого дня
      let ok = true
      for (const d of dates) {
        const w = windowFor(input.schedule, d)!
        const dOpen = zonedToUtcMs(tz, d, w.open)
        const dClose = zonedToUtcMs(tz, d, w.close)
        if (hall && !resourceFree(input, 'hall', hall.id, dOpen, dClose)) ok = false
      }
      if (!ok) continue
    }
    const spanDates = coveredDates(tz, span.startMs, span.endMs)
    if (spanDates.some((d) => !isDateOpen(input.schedule, input.closedDates, d))) continue

    if (hall && !hallFreeForSpan(input, hall, span, spanDates, input.peopleCount)) continue

    let specialistId: string | null = null
    if (service.needsSpecialist) {
      const pool = chosenSpecialist ? [chosenSpecialist] : activeSpecialists
      const found = pool.find((s) => specialistFreeForSpan(input, s, span, spanDates))
      if (!found) continue
      specialistId = found.id
    }
    slots.push({ startMs, specialistId })
  }

  return { slots }
}

export interface CancelPolicyInput {
  startsAtMs: number
  freeHours: number
  nowMs: number
  status: string
}

export function canCancelByPolicy({ startsAtMs, freeHours, nowMs, status }: CancelPolicyInput): {
  allowed: boolean
  reason?: string
} {
  if (['cancelled_by_client', 'rejected', 'completed', 'no_show'].includes(status)) {
    return { allowed: false, reason: 'Запись уже закрыта' }
  }
  if (nowMs > startsAtMs - freeHours * 3_600_000) {
    return { allowed: false, reason: `Отмена возможна не позднее чем за ${freeHours} ч` }
  }
  return { allowed: true }
}
