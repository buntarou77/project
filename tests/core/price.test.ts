import { describe, expect, it } from 'vitest'
import { calculatePrice } from '@/core/price'
import { zonedToUtcMs } from '@/core/time'
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

const hallBlack: Hall = { ...hall, id: 'hall-black', name: 'Чёрный зал' }

const rental: Service = { ...service, id: 'svc-rental', kind: 'rental', name: 'Аренда зала', priceType: 'hourly', price: 0, needsSpecialist: false, needsHall: true }

// допы считаются только по белому списку услуги (addonIds)
const serviceWithAddons: Service = { ...service, addonIds: ['ad-urgent', 'ad-person'] }
const rentalWithHour: Service = { ...rental, addonIds: ['ad-hour'] }

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
  { id: 'ad-cyclorama', appliesTo: 'rental', name: 'Циклорама', price: 800, unit: 'booking', hallIds: ['hall-white'] },
]

const zone: TravelZone = { id: 'suburb', name: 'Выезд за город', minutesBefore: 60, minutesAfter: 60, extraFee: 3000 }

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
      service: serviceWithAddons, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      selectedAddonIds: ['ad-urgent', 'ad-person'], addons, travelZone: null, peopleCount: 3,
    })
    expect(p.lines.find((l) => l.label.includes('Срочная'))!.amount).toBe(2000)
    expect(p.lines.find((l) => l.label.includes('× 3'))!.amount).toBe(1500)
    expect(p.total).toBe(5000 + 2000 + 1500)
  })

  it('услуга без addonIds: выбранные допы не считаются (нет легаси-фолбэка по appliesTo)', () => {
    const p = calculatePrice({
      service, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      // ad-urgent.appliesTo=shoot, но услуге не привязан — игнорируется
      selectedAddonIds: ['ad-urgent', 'ad-person'], addons, travelZone: null, peopleCount: 3,
    })
    expect(p.lines.some((l) => l.label.includes('Срочная'))).toBe(false)
    expect(p.total).toBe(5000)
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

  it('адонс с белым списком залов: считается только в своём зале', () => {
    const svc: Service = { ...rental, addonIds: ['ad-cyclorama'] }
    const inWhite = calculatePrice({
      service: svc, hall, tz: TZ, startUtcMs: saturdayNoon, durationMin: 60,
      selectedAddonIds: ['ad-cyclorama'], addons, travelZone: null,
    })
    expect(inWhite.lines.find((l) => l.label.includes('Циклорама'))!.amount).toBe(800)
    expect(inWhite.total).toBe(1600 + 800)

    const inBlack = calculatePrice({
      service: svc, hall: hallBlack, tz: TZ, startUtcMs: saturdayNoon, durationMin: 60,
      selectedAddonIds: ['ad-cyclorama'], addons, travelZone: null,
    })
    expect(inBlack.lines.some((l) => l.label.includes('Циклорама'))).toBe(false)
    expect(inBlack.total).toBe(1600)
  })

  it('адонс с белым списком залов: бронь без зала его не получает', () => {
    const svc: Service = { ...service, addonIds: ['ad-cyclorama'] }
    const p = calculatePrice({
      service: svc, hall: null, tz: TZ, startUtcMs: saturdayNoon,
      selectedAddonIds: ['ad-cyclorama'], addons, travelZone: null,
    })
    expect(p.lines.some((l) => l.label.includes('Циклорама'))).toBe(false)
    expect(p.total).toBe(5000)
  })

  it('адонс за час при аренде ×длительность', () => {
    const p = calculatePrice({
      service: rentalWithHour, hall, tz: TZ, startUtcMs: saturdayNoon, durationMin: 120,
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

  it('предоплата процентом не превышает итог (защита от старой конфигурации 2000%)', () => {
    const svc = { ...service, prepayment: { type: 'percent' as const, value: 2000 } }
    const p = calculatePrice({ service: svc, hall: null, tz: TZ, startUtcMs: saturdayNoon, selectedAddonIds: [], addons, travelZone: null })
    expect(p.total).toBe(5000)
    expect(p.prepayment).toBe(5000)
  })

  it('предоплата 100% равна итогу', () => {
    const svc = { ...service, prepayment: { type: 'percent' as const, value: 100 } }
    const p = calculatePrice({ service: svc, hall: null, tz: TZ, startUtcMs: saturdayNoon, selectedAddonIds: [], addons, travelZone: null })
    expect(p.total).toBe(5000)
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

  it('hourly без зала: цена = только ставка специалиста × часы', () => {
    const noHall: Service = { ...service, id: 'svc-hourly-nohall', priceType: 'hourly', price: 0, needsSpecialist: true, needsHall: false }
    const p = calculatePrice({
      service: noHall, hall: null, tz: TZ, startUtcMs: saturdayNoon, durationMin: 120,
      specialists: [{ name: 'Анна', hourRate: 1000 }],
      selectedAddonIds: [], addons, travelZone: null,
    })
    expect(p.total).toBe(2000)
    expect(p.lines).toHaveLength(1)
    expect(p.lines[0].label).toContain('Анна')
  })

  it('hourly без зала: несколько специалистов суммируются отдельными строками', () => {
    const noHall: Service = { ...service, id: 'svc-team-nohall', priceType: 'hourly', price: 0, needsSpecialist: true, needsHall: false, allSpecialistsRequired: true }
    const p = calculatePrice({
      service: noHall, hall: null, tz: TZ, startUtcMs: saturdayNoon, durationMin: 120,
      specialists: [{ name: 'Анна', hourRate: 1000 }, { name: 'Марк', hourRate: 700 }],
      selectedAddonIds: [], addons, travelZone: null,
    })
    expect(p.lines.filter((l) => l.label.startsWith('Специалист'))).toHaveLength(2)
    expect(p.total).toBe(3400)
  })

  it('hourly без зала и без специалиста — ошибка, а не бесплатная бронь', () => {
    const noHall: Service = { ...service, id: 'svc-hourly-empty', priceType: 'hourly', price: 0, needsSpecialist: true, needsHall: false }
    expect(() => calculatePrice({
      service: noHall, hall: null, tz: TZ, startUtcMs: saturdayNoon, durationMin: 60,
      selectedAddonIds: [], addons, travelZone: null,
    })).toThrow('Для почасовой услуги нужен зал или специалист')
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

  it('Y2: полные часы окон тарифицируются без капа — зал занят целиком', () => {
    // 2 дня × окно 10:00–21:00 (11 ч) = 22 часа по тарифам своих дат
    const p = calculatePrice({
      service: rental, hall, tz: TZ, startUtcMs: saturdayNoon,
      fullDayWindows: [
        { date: '2026-10-31', open: '10:00', close: '21:00' },
        { date: '2026-11-03', open: '10:00', close: '21:00' },
      ],
      selectedAddonIds: [], addons, travelZone: null,
    })
    // сб: 8 ч день ×1600 + 3 ч вечер ×1800; вт: 8 ч день ×1200 + 3 ч вечер ×1500
    expect(p.total).toBe((8 * 1600 + 3 * 1800) + (8 * 1200 + 3 * 1500))
  })

  it('Y1: ночное окно 22:00–06:00 — 8 часов по тарифу, час после полуночи по своей дате', () => {
    const p = calculatePrice({
      service: rental, hall, tz: TZ,
      startUtcMs: zonedToUtcMs(TZ, '2026-10-31', '22:00'), // суббота вечером
      fullDayWindows: [{ date: '2026-10-31', open: '22:00', close: '06:00' }],
      selectedAddonIds: [], addons, travelZone: null,
      eveningFrom: '23:00',
    })
    // сб 22:00 — день 1600, сб 23:00 — вечер 1800, вс 00:00–06:00 — 6 ч день 1600
    expect(p.total).toBe(1600 + 1800 + 6 * 1600)
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
