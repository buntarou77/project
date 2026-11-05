import { describe, expect, it } from 'vitest'
import { computeAvailability, bookingBlockSpan, canCancelByPolicy } from '@/core/availability'
import type { AvailabilityInput } from '@/core/availability'
import type { BusyInterval } from '@/core/time'
import { utcToZonedDate, zonedToUtcMs } from '@/core/time'
import type { Hall, Service, Specialist, WeekSchedule } from '@/core/types'

const TZ = 'Europe/Moscow'

const schedule: WeekSchedule = {
  mon: { open: '10:00', close: '21:00' },
  tue: { open: '10:00', close: '21:00' },
  wed: { open: '10:00', close: '21:00' },
  thu: { open: '10:00', close: '21:00' },
  fri: { open: '10:00', close: '21:00' },
  sat: { open: '10:00', close: '20:00' },
  sun: null,
}

const specialist: Specialist = { id: 'sp-1', name: 'Анна', title: '', active: true, dayLimit: 1 }
const hall: Hall = { id: 'hall-1', name: 'Зал', capacity: 5, rates: { weekday: { day: 1000, evening: 1000 }, weekend: { day: 1000, evening: 1000 } }, active: true }

const hourlyService: Service = {
  id: 'svc-rental', kind: 'rental', name: 'Аренда', description: '',
  priceType: 'hourly', price: 0, durationMin: 60, includes: [], deliverableText: '',
  deadlineDays: 0, prepayment: { type: 'percent', value: 0 },
  needsSpecialist: false, needsHall: true, fullDay: false, multiDayMax: 1,
  autoConfirm: true, setupMin: 0, cleanupMin: 0, sort: 0,
}

// 2026-11-02 — понедельник, рабочий день 10:00–21:00 МСК
const MON = '2026-11-02'
// 2026-10-31 — суббота, рабочий день 10:00–20:00 МСК
const SAT = '2026-10-31'
// 2026-11-01 — воскресенье, выходной
const SUN = '2026-11-01'

function base(overrides: Partial<AvailabilityInput>): AvailabilityInput {
  return {
    tz: TZ,
    schedule,
    closedDates: [],
    dateFrom: MON,
    service: hourlyService,
    specialistId: null,
    hallId: 'hall-1',
    specialists: [specialist],
    halls: [hall],
    busy: [],
    dayLimitBookings: [],
    fullDayBusy: [],
    offsite: false,
    travelBeforeMin: 0,
    travelAfterMin: 0,
    nowMs: new Date('2026-10-31T12:00:00Z').getTime(),
    ...overrides,
  }
}

describe('computeAvailability', () => {
  it('часовая аренда: слоты с шагом 30 мин от окна до закрытия с учётом уборки', () => {
    const svc = { ...hourlyService, cleanupMin: 30 }
    const r = computeAvailability(base({ service: svc, durationMin: 60 }))
    // 10:00 … последний старт 19:30 (конец 20:30 ≤ 21:00 с уборкой)
    expect(r.slots.length).toBeGreaterThan(0)
    const first = new Date(r.slots[0].startMs)
    const last = new Date(r.slots[r.slots.length - 1].startMs)
    expect(first.toISOString()).toBe('2026-11-02T07:00:00.000Z') // 10:00 МСК
    expect(last.toISOString()).toBe('2026-11-02T16:30:00.000Z') // 19:30 МСК
  })

  it('занятый интервал зала исключает пересекающиеся слоты', () => {
    const busyStart = zonedToUtcMs(TZ, MON, '13:00')
    const busy: BusyInterval[] = [{ resourceType: 'hall', resourceId: 'hall-1', startMs: busyStart, endMs: busyStart + 3_600_000 }]
    const r = computeAvailability(base({ busy }))
    const starts = r.slots.map((s) => s.startMs)
    expect(starts).not.toContain(zonedToUtcMs(TZ, MON, '13:00'))
    expect(starts).not.toContain(zonedToUtcMs(TZ, MON, '12:30')) // длится до 13:30, пересекает
    expect(starts).toContain(zonedToUtcMs(TZ, MON, '12:00')) // 12:00–13:00 впритык — допустимо
    expect(starts).toContain(zonedToUtcMs(TZ, MON, '14:00'))
  })

  it('выходной день: слотов нет', () => {
    const r = computeAvailability(base({ dateFrom: SUN }))
    expect(r.slots).toHaveLength(0)
    expect(r.reason).toContain('закрыта')
  })

  it('закрытая дата: слотов нет', () => {
    const r = computeAvailability(base({ closedDates: [MON] }))
    expect(r.slots).toHaveLength(0)
  })

  it('услуга со специалистом и залом: слот только когда свободны оба', () => {
    const svc = { ...hourlyService, needsSpecialist: true }
    const busyHall = zonedToUtcMs(TZ, MON, '12:00')
    const busy: BusyInterval[] = [{ resourceType: 'hall', resourceId: 'hall-1', startMs: busyHall, endMs: busyHall + 3_600_000 }]
    const r = computeAvailability(base({ service: svc, busy }))
    const starts = r.slots.map((s) => s.startMs)
    expect(starts).not.toContain(busyHall)
    // специалист свободен в 12:00, но зал занят → слота нет вообще
    expect(starts.filter((s) => s >= busyHall && s < busyHall + 3_600_000)).toHaveLength(0)
  })

  it('«любой свободный»: выбирает свободного специалиста, занятый пропускается', () => {
    const svc = { ...hourlyService, needsSpecialist: true }
    const sp2: Specialist = { id: 'sp-2', name: 'Марк', title: '', active: true, dayLimit: 1 }
    const busyStart = zonedToUtcMs(TZ, MON, '10:00')
    const busy: BusyInterval[] = [{ resourceType: 'specialist', resourceId: 'sp-1', startMs: busyStart, endMs: busyStart + 2 * 3_600_000 }]
    const r = computeAvailability(base({ service: svc, specialists: [specialist, sp2], busy, durationMin: 60 }))
    const atBusy = r.slots.find((s) => s.startMs === zonedToUtcMs(TZ, MON, '10:00'))
    expect(atBusy?.specialistId).toBe('sp-2')
  })

  it('лимит съёмок в день: специалист с занятым днём недоступен', () => {
    const svc = { ...hourlyService, needsSpecialist: true }
    const r = computeAvailability(
      base({ service: svc, dayLimitBookings: [{ date: MON, specialistId: 'sp-1' }] })
    )
    expect(r.slots).toHaveLength(0)
    const sp2: Specialist = { id: 'sp-2', name: 'Марк', title: '', active: true, dayLimit: 1 }
    const r2 = computeAvailability(
      base({ service: svc, dayLimitBookings: [{ date: MON, specialistId: 'sp-1' }], specialists: [specialist, sp2] })
    )
    expect(r2.slots.every((s) => s.specialistId === 'sp-2')).toBe(true)
  })

  it('полный день: единственный слот = окно открытия, занятый день исключается', () => {
    const fullDay: Service = { ...hourlyService, needsSpecialist: true, needsHall: false, fullDay: true }
    const ok = computeAvailability(base({ service: fullDay, hallId: null }))
    expect(ok.slots).toHaveLength(1)
    expect(ok.slots[0].startMs).toBe(zonedToUtcMs(TZ, MON, '10:00'))

    const busy = computeAvailability(base({ service: fullDay, hallId: null, fullDayBusy: [{ date: MON, resourceType: 'specialist', resourceId: 'sp-1' }] }))
    expect(busy.slots).toHaveLength(0)
  })

  it('многодневная съёмка блокирует все дни', () => {
    const multi: Service = { ...hourlyService, needsSpecialist: true, needsHall: false, multiDayMax: 2 }
    const r = computeAvailability(base({ service: multi, hallId: null, dateFrom: SAT, dayCount: 2 }))
    // суббота+воскресенье: воскресенье закрыто → слотов нет
    expect(r.slots).toHaveLength(0)
    const r2 = computeAvailability(base({ service: multi, hallId: null, dateFrom: MON, dayCount: 2 }))
    expect(r2.slots).toHaveLength(1)
  })

  it('бронь через полночь: интервал накрывает обе даты', () => {
    const start = zonedToUtcMs(TZ, SAT, '22:00')
    const span = bookingBlockSpan({ ...hourlyService, setupMin: 0, cleanupMin: 0 }, start, 180, false, 0, 0)
    expect(span.startMs).toBe(start)
    expect(span.endMs).toBe(start + 180 * 60_000)
    expect(utcToZonedDate(TZ, span.endMs)).toBe('2026-11-01')
  })

  it('уборка после съёмки сдвигает последний доступный слот', () => {
    const svc = { ...hourlyService, cleanupMin: 60 }
    const r = computeAvailability(base({ service: svc, dateFrom: SAT, durationMin: 60 }))
    const last = r.slots[r.slots.length - 1].startMs
    expect(last).toBe(zonedToUtcMs(TZ, SAT, '18:00')) // 19:00–20:00 + час уборки = 21:00 > 20:00
  })

  it('дорога на выезде расширяет интервал блокировки', () => {
    const span = bookingBlockSpan(hourlyService, zonedToUtcMs(TZ, MON, '12:00'), 60, true, 45, 30)
    expect(span.startMs).toBe(zonedToUtcMs(TZ, MON, '11:15'))
    expect(span.endMs).toBe(zonedToUtcMs(TZ, MON, '13:30'))
  })

  it('прошедшие слоты отсекаются по nowMs', () => {
    const now = zonedToUtcMs(TZ, MON, '12:00')
    const r = computeAvailability(base({ nowMs: now }))
    expect(r.slots.every((s) => s.startMs >= now)).toBe(true)
  })
})

describe('canCancelByPolicy', () => {
  const start = zonedToUtcMs(TZ, MON, '12:00')
  it('разрешает отмену раньше freeHours', () => {
    expect(canCancelByPolicy({ startsAtMs: start, freeHours: 48, nowMs: start - 49 * 3_600_000, status: 'confirmed' }).allowed).toBe(true)
  })
  it('запрещает позже окна и для закрытых статусов', () => {
    expect(canCancelByPolicy({ startsAtMs: start, freeHours: 48, nowMs: start - 47 * 3_600_000, status: 'confirmed' }).allowed).toBe(false)
    expect(canCancelByPolicy({ startsAtMs: start, freeHours: 48, nowMs: start - 72 * 3_600_000, status: 'completed' }).allowed).toBe(false)
  })
})
