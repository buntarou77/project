import { describe, expect, it } from 'vitest'
import { calculatePrice } from '@/core/price'
import type { Addon, Hall, Service, TravelZone } from '@/core/types'

const TZ = 'Europe/Moscow'

const service: Service = {
  id: 'svc-portrait',
  kind: 'shoot',
  name: 'Портретная съёмка',
  description: '',
  priceType: 'fixed',
  price: 5000,
  durationMin: 60,
  includes: [],
  deliverableText: '',
  deadlineDays: 5,
  prepayment: { type: 'percent', value: 30 },
  needsSpecialist: true,
  needsHall: false,
  fullDay: false,
  multiDayMax: 1,
  autoConfirm: false,
  setupMin: 0,
  cleanupMin: 0,
  sort: 1,
}

const hall: Hall = {
  id: 'hall-white',
  name: 'Белый зал',
  capacity: 8,
  rates: {
    weekday: { day: 1200, evening: 1500 },
    weekend: { day: 1600, evening: 1800 },
  },
  active: true,
}

const rental: Service = { ...service, id: 'svc-rental', kind: 'rental', name: 'Аренда зала', priceType: 'hourly', price: 0, needsSpecialist: false, needsHall: true }

// 2026-10-31 — суббота, 2026-11-02 — понедельник
const saturdayNoon = new Date('2026-10-31T09:00:00Z').getTime() // 12:00 МСК
const mondayEvening = new Date('2026-11-02T16:00:00Z').getTime() // 19:00 МСК

const addons: Addon[] = [
  { id: 'ad-urgent', appliesTo: 'shoot', name: 'Срочная обработка', price: 2000, unit: 'booking' },
  { id: 'ad-person', appliesTo: 'shoot', name: 'Доп. человек', price: 500, unit: 'person' },
  { id: 'ad-hour', appliesTo: 'rental', name: 'Доп. час', price: 1500, unit: 'hour' },
]

const zone: TravelZone = { id: 'suburb', name: 'за город', minutesBefore: 60, minutesAfter: 60, extraFee: 3000 }

describe('calculatePrice', () => {
  it('фиксированный пакет + предоплата процентом', () => {
    const p = calculatePrice({
      service, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      selectedAddonIds: [], addons, travelZone: null,
    })
    expect(p.total).toBe(5000)
    expect(p.prepayment).toBe(1500)
  })

  it('адонсы: booking ×1, person ×люди', () => {
    const p = calculatePrice({
      service, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      selectedAddonIds: ['ad-urgent', 'ad-person'], addons, travelZone: null, peopleCount: 3,
    })
    expect(p.lines.find((l) => l.label.includes('Срочная'))!.amount).toBe(2000)
    expect(p.lines.find((l) => l.label.includes('× 3'))!.amount).toBe(1500)
    expect(p.total).toBe(5000 + 2000 + 1500)
  })

  it('аренда: тариф выходного дня в дневное время', () => {
    const p = calculatePrice({
      service: rental, hall, tz: TZ, startUtcMs: saturdayNoon, durationMin: 120,
      selectedAddonIds: [], addons, travelZone: null,
    })
    expect(p.total).toBe(1600 * 2)
  })

  it('аренда: вечерний тариф буднего дня', () => {
    const p = calculatePrice({
      service: rental, hall, tz: TZ, startUtcMs: mondayEvening, durationMin: 60,
      selectedAddonIds: [], addons, travelZone: null, eveningFrom: '18:00',
    })
    expect(p.total).toBe(1500)
  })

  it('аренда через полночь: часы до и после полуночи тарифицируются по своим датам', () => {
    // 2026-11-01 (воскресенье) 22:00 МСК + 3 часа → заходит в понедельник
    const start = new Date('2026-11-01T19:00:00Z').getTime()
    const p = calculatePrice({
      service: rental, hall, tz: TZ, startUtcMs: start, durationMin: 180,
      selectedAddonIds: [], addons, travelZone: null, eveningFrom: '18:00',
    })
    // вс 22:00 = 1800 (выходной вечер), вс 23:00 = 1800, пн 00:00 = 1200 (будний день)
    expect(p.total).toBe(1800 + 1800 + 1200)
  })

  it('адонс за час при аренде ×длительность', () => {
    const p = calculatePrice({
      service: rental, hall, tz: TZ, startUtcMs: saturdayNoon, durationMin: 120,
      selectedAddonIds: ['ad-hour'], addons, travelZone: null,
    })
    expect(p.lines.find((l) => l.label.includes('Доп. час'))!.amount).toBe(3000)
  })

  it('доплата за выезд', () => {
    const p = calculatePrice({
      service, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      selectedAddonIds: [], addons, travelZone: zone,
    })
    expect(p.total).toBe(8000)
  })

  it('предоплата суммой не превышает итог', () => {
    const svc = { ...service, prepayment: { type: 'amount' as const, value: 999999 } }
    const p = calculatePrice({ service: svc, hall: null, tz: TZ, startUtcMs: saturdayNoon, selectedAddonIds: [], addons, travelZone: null })
    expect(p.prepayment).toBe(5000)
  })
})
