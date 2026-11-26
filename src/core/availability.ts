import type { Hall, Service, Specialist, WeekSchedule } from './types'
import {
  addDaysToDateString,
  type BusyInterval,
  type BusyResourceType,
  overlaps,
  type TimeInterval,
  utcToZonedDate,
  weekdayKeyOfDate,
  windowDurationMin,
  zonedToUtcMs,
} from './time'

// Услуга со специалистом и без зала проводится только на выезде:
// иначе бронь фиксировала бы «специалиста где-то» без места, дороги и сбора.
export function offsiteRequiredFor(
  service: Pick<Service, 'needsSpecialist' | 'needsHall' | 'kind'>
): boolean {
  return service.needsSpecialist && !(service.needsHall || service.kind === 'rental')
}

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
  // закрытия всей студии (resource_type/resource_id = null): проверяются
  // отдельно, иначе услуга без зала и специалиста их не видит (B-68)
  studioBusy?: TimeInterval[]
  dayLimitBookings: { date: string; specialistId: string }[]
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
  // команда услуги: все эти специалисты должны быть свободны и блокируются
  specialistIds?: string[]
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
  // отсутствующий день графика — закрыт, а не «открыт» (undefined !== null)
  return schedule[key] != null
}

// Y1: окно дня с учётом ночи. Конец — UTC-мс; для ночной смены это
// следующий день. null — день закрыт.
function windowSpanMs(tz: string, schedule: WeekSchedule, date: string): { openMs: number; closeMs: number } | null {
  const w = schedule[weekdayKeyOfDate(date)]
  if (!w) return null
  const openMs = zonedToUtcMs(tz, date, w.open)
  const closeMs = openMs + windowDurationMin(w.open, w.close) * 60_000
  return { openMs, closeMs }
}

// B-93: дата рабочего окна, которому принадлежит старт. Для ночной смены
// 01:00 субботы — это пятница: выдача слотов строится по пятничному окну,
// и создание/перенос обязаны искать слот по той же дате, иначе 01:00
// «теряется» (субботнее окно начинается только вечером).
export function workdayDateForStart(
  tz: string,
  schedule: WeekSchedule,
  startUtcMs: number,
  slotEndMs?: number
): string {
  const own = utcToZonedDate(tz, startUtcMs)
  const ownSpan = windowSpanMs(tz, schedule, own)
  // B-93: при переносе/создании окно должно вмещать слот целиком, иначе
  // слот, выданный по пятничному окну, «переезжает» на субботнее
  const ownFits = ownSpan && startUtcMs >= ownSpan.openMs && startUtcMs < ownSpan.closeMs
    && (slotEndMs === undefined || ownSpan.closeMs >= slotEndMs)
  if (ownFits) return own
  const prev = addDaysToDateString(own, -1)
  const prevSpan = windowSpanMs(tz, schedule, prev)
  const prevFits = prevSpan && startUtcMs >= prevSpan.openMs && startUtcMs < prevSpan.closeMs
    && (slotEndMs === undefined || prevSpan.closeMs >= slotEndMs)
  if (prevFits) return prev
  return own
}

function specialistDayCount(input: AvailabilityInput, specialistId: string, date: string): number {
  return input.dayLimitBookings.filter((b) => b.specialistId === specialistId && b.date === date).length
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

// Свой график специалиста (или график студии): слот обязан целиком ложиться
// в объединение его окон задействованных дней. Выходной — слота нет.
function specialistWindowOk(input: AvailabilityInput, s: Specialist, span: { startMs: number; endMs: number }, dates: string[]): boolean {
  const sched = s.schedule ?? input.schedule
  // Y1: строим разрешающие интервалы (UTC) каждого задействованного дня —
  // окно может быть ночным и уходить на следующие сутки. Слот должен целиком
  // покрыться объединением интервалов.
  // Y1: слот после полуночи может быть покрыт ЕЩЁ и ночным окном предыдущего
  // дня (00:00–06:00 вторника — это продолжение понедельничной смены).
  const windowDates = [...new Set(dates.flatMap((d) => [addDaysToDateString(d, -1), d]))]
  const spans = windowDates
    .map((d) => windowSpanMs(input.tz, sched, d))
    .filter((x): x is { openMs: number; closeMs: number } => x !== null)
    .sort((a, b) => a.openMs - b.openMs)
  if (spans.length === 0) return false
  // объединение: пересекающиеся интервалы склеиваем
  const merged: { openMs: number; closeMs: number }[] = []
  for (const sp of spans) {
    const last = merged[merged.length - 1]
    if (last && sp.openMs <= last.closeMs) {
      if (sp.closeMs > last.closeMs) last.closeMs = sp.closeMs
    } else {
      merged.push({ ...sp })
    }
  }
  let cursor = span.startMs
  for (const m of merged) {
    if (m.openMs > cursor) return false // дыра до этого интервала
    if (m.closeMs >= span.endMs) return true // слот целиком покрыт
    cursor = Math.max(cursor, m.closeMs)
  }
  return cursor >= span.endMs
}

function specialistFreeForSpan(
  input: AvailabilityInput,
  s: Specialist,
  span: { startMs: number; endMs: number },
  dates: string[]
): boolean {
  for (const date of dates) {
    if (specialistDayCount(input, s.id, date) >= s.dayLimit) return false
  }
  return specialistWindowOk(input, s, span, dates) && resourceFree(input, 'specialist', s.id, span.startMs, span.endMs)
}

function hallFreeForSpan(
  input: AvailabilityInput,
  hall: Hall,
  span: { startMs: number; endMs: number },
  dates: string[],
  peopleCount?: number
): boolean {
  if (peopleCount && peopleCount > hall.capacity) return false
  return resourceFree(input, 'hall', hall.id, span.startMs, span.endMs)
}

// Полнодневная/многодневная блокировка: сервер (buildResourceIntervals) пишет
// в booking_resources целые окна каждого дня БЕЗ буферов setup/cleanup —
// доступность проверяем так же, по окну каждого дня.
// Окно студии дня обязано существовать: закрытость дат уже проверена выше.
function hallFreeForDays(
  input: AvailabilityInput,
  hall: Hall,
  dates: string[],
  peopleCount?: number,
  travelBeforeMin = 0,
  travelAfterMin = 0
): boolean {
  if (peopleCount && peopleCount > hall.capacity) return false
  for (let i = 0; i < dates.length; i++) {
    const span = windowSpanMs(input.tz, input.schedule, dates[i])
    if (!span) return false
    // B-14: дорога выезда расширяет только проверку занятости — сам день
    // по-прежнему ограничен сырым окном
    const from = i === 0 ? span.openMs - travelBeforeMin * 60_000 : span.openMs
    const to = i === dates.length - 1 ? span.closeMs + travelAfterMin * 60_000 : span.closeMs
    if (!resourceFree(input, 'hall', hall.id, from, to)) return false
  }
  return true
}

function specialistFreeForDays(
  input: AvailabilityInput,
  s: Specialist,
  dates: string[],
  travelBeforeMin = 0,
  travelAfterMin = 0
): boolean {
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i]
    if (specialistDayCount(input, s.id, d) >= s.dayLimit) return false
    const span = windowSpanMs(input.tz, input.schedule, d)
    if (!span) return false
    // Y1: окно специалиста может быть ночным — считаем его длительность
    const sched = s.schedule ?? input.schedule
    const sw = sched[weekdayKeyOfDate(d)]
    if (!sw) return false
    const specSpan = windowSpanMs(input.tz, sched, d)
    if (!specSpan) return false
    // блокируется всё окно студии — оно должно целиком попадать в окно специалиста
    if (span.openMs < specSpan.openMs || span.closeMs > specSpan.closeMs) return false
    // B-14: принадлежность окну специалиста проверена по сырому окну,
    // дорога расширяет только проверку занятости
    const from = i === 0 ? span.openMs - travelBeforeMin * 60_000 : span.openMs
    const to = i === dates.length - 1 ? span.closeMs + travelAfterMin * 60_000 : span.closeMs
    if (!resourceFree(input, 'specialist', s.id, from, to)) return false
  }
  return true
}

export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const { service, tz } = input
  const durationMin = input.durationMin ?? service.durationMin
  const stepMin = input.stepMin ?? 30
  const dayCount = input.dayCount ?? 1
  // полный день и многодневность блокируют целые окна каждого дня (без буферов)
  const perDayBlocking = service.fullDay || dayCount > 1
  const nowMs = input.nowMs

  const activeSpecialists = input.specialists.filter((s) => s.active)
  const activeHalls = input.halls.filter((h) => h.active)

  const needsHall = service.needsHall || service.kind === 'rental'
  const hall = input.hallId ? activeHalls.find((h) => h.id === input.hallId) : null
  if (input.hallId && !hall) return { slots: [], reason: 'Зал недоступен' }
  if (needsHall && !hall) return { slots: [], reason: 'Выберите зал' }
  const chosenSpecialist = input.specialistId ? activeSpecialists.find((s) => s.id === input.specialistId) : null
  // Услуга-команда: состав задаёт админ, клиент никого не выбирает.
  // Пустой состав — ошибка настроек, а не «любой свободный».
  const teamIds = service.needsSpecialist && service.allSpecialistsRequired
    ? service.specialistIds ?? []
    : []
  if (service.needsSpecialist && service.allSpecialistsRequired && teamIds.length === 0) {
    return { slots: [], reason: 'В услуге не настроены специалисты' }
  }
  const team = teamIds.map((id) => activeSpecialists.find((s) => s.id === id))
  if (teamIds.length > 0 && team.some((s) => !s)) {
    return { slots: [], reason: 'Не все специалисты услуги доступны' }
  }
  const teamSpecialists = team as Specialist[]
  if (input.specialistId && !chosenSpecialist && teamSpecialists.length === 0) {
    return { slots: [], reason: 'Специалист недоступен' }
  }
  if (teamSpecialists.length > 0 && chosenSpecialist && !teamSpecialists.some((s) => s.id === chosenSpecialist.id)) {
    return { slots: [], reason: 'Специалист недоступен для этой услуги' }
  }

  const dates: string[] = []
  for (let i = 0; i < dayCount; i++) dates.push(addDaysToDateString(input.dateFrom, i))
  for (const d of dates) {
    if (!isDateOpen(input.schedule, input.closedDates, d)) return { slots: [], reason: `Дата ${d} закрыта` }
  }

  // Y1: окно может быть ночным — конец на следующие сутки
  // день без окна в графике — закрыт: без проверки здесь разыменовывался null
  const firstSpan = windowSpanMs(tz, input.schedule, dates[0])
  if (!firstSpan) return { slots: [], reason: 'Дата закрыта' }
  const openMs = firstSpan.openMs
  const closeMs = firstSpan.closeMs

  const candidates: number[] = []
  if (perDayBlocking) {
    candidates.push(openMs)
  } else {
    const tail = durationMin * 60_000 + service.cleanupMin * 60_000 + (input.offsite ? input.travelAfterMin * 60_000 : 0)
    for (let t = openMs; t + tail <= closeMs; t += stepMin * 60_000) {
      if (nowMs !== undefined && t < nowMs) continue
      candidates.push(t)
    }
  }

  const slots: FreeSlot[] = []
  // B-14: на выезде дорога расширяет проверку занятости полнодневной брони:
  // первый день начинается раньше открытия, последний кончается позже закрытия
  const travelBefore = input.offsite ? input.travelBeforeMin : 0
  const travelAfter = input.offsite ? input.travelAfterMin : 0
  for (const startMs of candidates) {
    if (perDayBlocking) {
      if (nowMs !== undefined && startMs < nowMs) continue
      // закрытие всей студии: услуга без ресурсов иначе его не замечает
      if (
        (input.studioBusy ?? []).some((b) =>
          dates.some((d) => {
            const sp = windowSpanMs(tz, input.schedule, d)
            return sp ? overlaps(b.startMs, b.endMs, sp.openMs, sp.closeMs) : false
          })
        )
      ) {
        continue
      }
      if (hall && !hallFreeForDays(input, hall, dates, input.peopleCount, travelBefore, travelAfter)) continue
      let specialistId: string | null = null
      let specialistIds: string[] | undefined
      if (teamSpecialists.length > 0) {
        if (!teamSpecialists.every((s) => specialistFreeForDays(input, s, dates, travelBefore, travelAfter))) continue
        specialistIds = teamSpecialists.map((s) => s.id)
        specialistId = specialistIds[0]
      } else if (service.needsSpecialist) {
        const pool = chosenSpecialist ? [chosenSpecialist] : activeSpecialists
        const found = pool.find((s) => specialistFreeForDays(input, s, dates, travelBefore, travelAfter))
        if (!found) continue
        specialistId = found.id
      }
      slots.push({ startMs, specialistId, ...(specialistIds ? { specialistIds } : {}) })
      continue
    }

    const span = bookingBlockSpan(
      service,
      startMs,
      durationMin,
      input.offsite,
      input.travelBeforeMin,
      input.travelAfterMin
    )
    const spanDates = coveredDates(tz, span.startMs, span.endMs)
    if (spanDates.some((d) => !isDateOpen(input.schedule, input.closedDates, d))) continue
    // закрытие всей студии действует на любую услугу, включая безресурсную
    if ((input.studioBusy ?? []).some((b) => overlaps(b.startMs, b.endMs, span.startMs, span.endMs))) continue

    if (hall && !hallFreeForSpan(input, hall, span, spanDates, input.peopleCount)) continue

    let specialistId: string | null = null
    let specialistIds: string[] | undefined
    if (teamSpecialists.length > 0) {
      if (!teamSpecialists.every((s) => specialistFreeForSpan(input, s, span, spanDates))) continue
      specialistIds = teamSpecialists.map((s) => s.id)
      specialistId = specialistIds[0]
    } else if (service.needsSpecialist) {
      const pool = chosenSpecialist ? [chosenSpecialist] : activeSpecialists
      const found = pool.find((s) => specialistFreeForSpan(input, s, span, spanDates))
      if (!found) continue
      specialistId = found.id
    }
    slots.push({ startMs, specialistId, ...(specialistIds ? { specialistIds } : {}) })
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
