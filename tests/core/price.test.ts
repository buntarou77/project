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

// фикс-пакет «под ключ» с базой 600 мин; окно «весь день» субботы шире базы
const wedding: Service = { ...service, id: 'svc-wedding', name: 'Свадьбы под ключ', price: 45000, durationMin: 600 }
const fullDayWin = { date: '2026-10-31', open: '10:00', close: '21:00' } // 660 мин

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

  it('адонсы по белому списку услуги: чужие игнорируются, свои считаются', () => {
    const withList: Service = { ...service, addonIds: ['ad-person'] }
    const p = calculatePrice({
      service: withList, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      // ad-urgent в списке нет — должен отфильтроваться, несмотря на appliesTo
      selectedAddonIds: ['ad-urgent', 'ad-person'], addons, travelZone: null, peopleCount: 2,
    })
    expect(p.lines.some((l) => l.label.includes('Срочная'))).toBe(false)
    expect(p.lines.find((l) => l.label.includes('× 2'))!.amount).toBe(1000)
    expect(p.total).toBe(5000 + 1000)
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

  it('fixed + «весь день» (durationMin undefined): один пакет за день', () => {
    // полный день не передаёт durationMin → k=1, кратность по минутам не возникает
    const p = calculatePrice({
      service: wedding, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      fullDayWindows: [fullDayWin],
      selectedAddonIds: [], addons, travelZone: null,
    })
    expect(p.total).toBe(45000)
    expect(p.lines[0].label).toBe('Свадьбы под ключ')
  })

  it('fixed + «весь день» на 2 дня: пакет × 2', () => {
    const p = calculatePrice({
      service: wedding, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      fullDayWindows: [fullDayWin, { date: '2026-11-03', open: '10:00', close: '20:00' }],
      selectedAddonIds: [], addons, travelZone: null,
    })
    expect(p.lines[0].label).toBe('Свадьбы под ключ × 2')
    expect(p.total).toBe(90000)
  })

  it('fixed + «весь день»: зал не нужен, ставка специалиста не добавляется', () => {
    const p = calculatePrice({
      service: wedding, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      fullDayWindows: [fullDayWin],
      specialist: { name: 'Анна', hourRate: 1000 },
      selectedAddonIds: [], addons, travelZone: null,
    })
    expect(p.lines.some((l) => l.label.startsWith('Специалист'))).toBe(false)
    expect(p.total).toBe(45000)
  })

  it('fixed + многодневная не-fullDay: k пакетов в день (durationMin 120 при базе 90 → ×4 на 2 дня)', () => {
    const multiDay: Service = { ...service, id: 'svc-multiday', name: 'Многочасовая съёмка', price: 7000, durationMin: 90 }
    const p = calculatePrice({
      service: multiDay, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      durationMin: 120,
      fullDayWindows: [fullDayWin, { date: '2026-11-03', open: '10:00', close: '20:00' }],
      selectedAddonIds: [], addons, travelZone: null,
    })
    expect(p.lines[0].label).toBe('Многочасовая съёмка × 4')
    expect(p.lines[0].amount).toBe(28000)
  })

  it('hourly + «весь день» + hoursPerDay 2: по 2 часа каждого окна, кап на специалиста и аддоны', () => {
    const p = calculatePrice({
      service: rental, hall, tz: TZ, startUtcMs: saturdayNoon,
      hoursPerDay: 2, eveningFrom: '11:00',
      fullDayWindows: [
        { date: '2026-10-31', open: '10:00', close: '21:00' }, // суббота: час 10 день, час 11 вечер
        { date: '2026-11-03', open: '10:00', close: '21:00' }, // вторник: час 10 день, час 11 вечер
      ],
      specialist: { name: 'Анна', hourRate: 500 },
      selectedAddonIds: ['ad-hour'], addons, travelZone: null,
    })
    // внутри капа по два тарифа: сб 1600+1800, вт 1200+1500
    expect(p.lines.find((l) => l.label.includes('Аренда'))!.amount).toBe(1600 + 1800 + 1200 + 1500)
    expect(p.lines.find((l) => l.label.startsWith('Специалист'))!.amount).toBe(500 * 4)
    expect(p.lines.find((l) => l.label.includes('Доп. час'))!.amount).toBe(1500 * 4)
  })

  it('hourly + «весь день» без hoursPerDay: все полные часы окон', () => {
    const p = calculatePrice({
      service: rental, hall, tz: TZ, startUtcMs: saturdayNoon, eveningFrom: '18:00',
      fullDayWindows: [
        { date: '2026-10-31', open: '10:00', close: '21:00' }, // 11 ч: 8 дн.×1600 + 3 веч.×1800
        { date: '2026-11-03', open: '10:00', close: '20:00' }, // 10 ч: 8 дн.×1200 + 2 веч.×1500
      ],
      selectedAddonIds: [], addons, travelZone: null,
    })
    expect(p.total).toBe(8 * 1600 + 3 * 1800 + 8 * 1200 + 2 * 1500)
  })

  it('hoursPerDay больше окна: тарифицируются только полные часы окна', () => {
    const p = calculatePrice({
      service: rental, hall, tz: TZ, startUtcMs: saturdayNoon,
      hoursPerDay: 8,
      fullDayWindows: [{ date: '2026-10-31', open: '10:00', close: '13:30' }], // 3 полных часа
      selectedAddonIds: ['ad-hour'], addons, travelZone: null,
    })
    expect(p.lines.find((l) => l.label.includes('Аренда'))!.amount).toBe(1600 * 3)
    expect(p.lines.find((l) => l.label.includes('Доп. час'))!.amount).toBe(1500 * 3)
  })

  it('адонс за час при «весь день»: часы от суммарных минут окон, а не от базы', () => {
    const withAddon: Service = { ...wedding, addonIds: ['ad-hour'] }
    const p = calculatePrice({
      service: withAddon, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      fullDayWindows: [fullDayWin, { date: '2026-11-03', open: '10:00', close: '20:00' }],
      selectedAddonIds: ['ad-hour'], addons, travelZone: null,
    })
    // 11 + 10 полных часов окон, а не 10 от durationMin=600
    expect(p.lines.find((l) => l.label.includes('Доп. час'))!.amount).toBe(1500 * 21)
  })
})
