import type { Addon, Hall, Service, TravelZone, WeekSchedule } from './types'
import {
  addDaysToDateString,
  isWeekendDate,
  minutesOf,
  utcToZonedDate,
  utcToZonedTime,
  weekdayKeyOfDate,
  zonedToUtcMs,
} from './time'

export interface PriceInput {
  service: Service
  hall: Hall | null
  tz: string
  startUtcMs: number
  durationMin?: number
  peopleCount?: number
  selectedAddonIds: string[]
  addons: Addon[]
  travelZone: TravelZone | null
  eveningFrom?: string
  // «Весь день»: почасовая цена по окнам каждого дня (открытие→закрытие),
  // вместо durationMin. Строит buildFullDayWindows.
  fullDayWindows?: FullDayWindow[]
  // Многодневная не-fullDay: клиент выбрал H часов в день. При расчёте по окнам
  // (fullDayWindows) ограничивает тарифицируемые часы каждого окна сверху —
  // зал блокируется на всё окно, а клиент платит за H часов в день.
  // Полный день (fullDay) поле не передаёт — часы не ограничены.
  hoursPerDay?: number
  // специалист почасовой услуги: отдельная строка «человеко-часы»
  specialist?: { name: string; hourRate: number } | null
}

export interface FullDayWindow {
  date: string
  open: string
  close: string
}

// Окна «весь день» по графику студии для dayCount дней от даты старта.
// Возвращает суммарные минуты и конец последнего дня — для ends_at брони.
export function buildFullDayWindows(
  schedule: WeekSchedule,
  tz: string,
  startUtcMs: number,
  dayCount: number
): { windows: FullDayWindow[]; totalMinutes: number; lastCloseMs: number } {
  const first = utcToZonedDate(tz, startUtcMs)
  const windows: FullDayWindow[] = []
  for (let i = 0; i < Math.max(1, dayCount); i++) {
    const d = addDaysToDateString(first, i)
    const w = schedule[weekdayKeyOfDate(d)]
    if (w) windows.push({ date: d, open: w.open, close: w.close })
  }
  const totalMinutes = windows.reduce((s, w) => s + minutesOf(w.close) - minutesOf(w.open), 0)
  const last = windows[windows.length - 1]
  const lastCloseMs = last ? zonedToUtcMs(tz, last.date, last.close) : startUtcMs
  return { windows, totalMinutes, lastCloseMs }
}

export interface PriceLine {
  label: string
  amount: number
}

export interface PriceBreakdown {
  lines: PriceLine[]
  total: number
  prepayment: number
}

export function ceilHours(durationMin: number): number {
  return Math.max(1, Math.ceil(durationMin / 60))
}

function hourRateFor(hall: Hall, date: string, timeHHmm: string, eveningFrom: string): number {
  const rates = isWeekendDate(date) ? hall.rates.weekend : hall.rates.weekday
  const evening = minutesOf(timeHHmm) >= minutesOf(eveningFrom || '18:00')
  return evening ? rates.evening : rates.day
}

export function calculatePrice(input: PriceInput): PriceBreakdown {
  const { service, hall, tz, startUtcMs, travelZone } = input
  const durationMin = input.durationMin ?? service.durationMin
  const people = Math.max(1, input.peopleCount ?? 1)
  const lines: PriceLine[] = []

  // Тарифицируемые часы каждого окна «весь день»: полные часы окна, но не больше
  // hoursPerDay (многодневная не-fullDay: зал блокируется на всё окно, клиент
  // платит за выбранные H часов в день). Одна сумма — на тариф, специалиста и аддоны.
  const hoursPerWindow = input.fullDayWindows
    ? input.fullDayWindows.map((w) => {
        const full = Math.floor((minutesOf(w.close) - minutesOf(w.open)) / 60)
        return input.hoursPerDay !== undefined ? Math.min(input.hoursPerDay, full) : full
      })
    : null
  const windowsHours = hoursPerWindow?.reduce((s, h) => s + h, 0) ?? 0

  if (input.fullDayWindows?.length) {
    if (service.priceType === 'fixed') {
      // Фикс-пакет по окнам: k пакетов В ДЕНЬ при многодневной не-fullDay
      // (durationMin — выбранные клиентом часы). Полный день передаёт
      // durationMin=undefined → k=1 → «пакет × число дней».
      const k = input.durationMin ? Math.max(1, Math.ceil(input.durationMin / service.durationMin)) : 1
      const qty = k * input.fullDayWindows.length
      lines.push({ label: qty > 1 ? `${service.name} × ${qty}` : service.name, amount: service.price * qty })
    } else {
      // «Весь день» почасово: тарифицируемые часы каждого окна по своему тарифу (будни/выходные, день/вечер)
      if (!hall) throw new Error('Для почасовой услуги нужен зал')
      const perWindow = hoursPerWindow ?? []
      let rental = 0
      input.fullDayWindows.forEach((w, i) => {
        for (let h = 0; h < perWindow[i]; h++) {
          const m = minutesOf(w.open) + h * 60
          const hh = String(Math.floor(m / 60)).padStart(2, '0')
          const mm = String(m % 60).padStart(2, '0')
          rental += hourRateFor(hall, w.date, `${hh}:${mm}`, input.eveningFrom ?? '18:00')
        }
      })
      lines.push({ label: `${service.name} · ${hall.name}`, amount: rental })
      if (input.specialist && input.specialist.hourRate > 0) {
        lines.push({ label: `Специалист: ${input.specialist.name}`, amount: input.specialist.hourRate * windowsHours })
      }
    }
  } else if (service.priceType === 'fixed') {
    // кратность: клиент берёт абсолютную длительность — считаем целое число
    // базовых пакетов (5 ч при базе 2 ч → ×3), минимум один пакет
    const k = input.durationMin ? Math.max(1, Math.ceil(input.durationMin / service.durationMin)) : 1
    lines.push({ label: k > 1 ? `${service.name} × ${k}` : service.name, amount: service.price * k })
  } else {
    if (!hall) throw new Error('Для почасовой услуги нужен зал')
    const hours = ceilHours(durationMin)
    let rental = 0
    for (let i = 0; i < hours; i++) {
      const hourStartMs = startUtcMs + i * 3_600_000
      const date = utcToZonedDate(tz, hourStartMs)
      const time = utcToZonedTime(tz, hourStartMs)
      rental += hourRateFor(hall, date, time, input.eveningFrom ?? '18:00')
    }
    lines.push({ label: `${service.name} · ${hall.name}`, amount: rental })
    if (input.specialist && input.specialist.hourRate > 0) {
      lines.push({ label: `Специалист: ${input.specialist.name}`, amount: input.specialist.hourRate * hours })
    }
  }

  // часы почасовых аддонов: при «весь день» — тарифицируемые (капнутые по
  // hoursPerDay) часы окон, одинаково для fixed и hourly, иначе — часы от длительности
  const hours = input.fullDayWindows?.length ? windowsHours : ceilHours(durationMin)
  for (const id of input.selectedAddonIds) {
    const addon = input.addons.find((a) => a.id === id)
    if (!addon) continue
    // привязка к услуге: явный список addonIds главнее; легаси-услуги
    // без списка фильтруются по appliesTo (съёмки/аренда)
    if (input.service.addonIds) {
      if (!input.service.addonIds.includes(addon.id)) continue
    } else if (addon.appliesTo !== 'both' && addon.appliesTo !== service.kind) {
      continue
    }
    const qty =
      addon.unit === 'booking' ? 1 : addon.unit === 'hour' ? hours : people
    lines.push({
      label: qty > 1 ? `${addon.name} × ${qty}` : addon.name,
      amount: addon.price * qty,
    })
  }

  if (travelZone && travelZone.extraFee > 0) {
    lines.push({ label: `Выезд: ${travelZone.name}`, amount: travelZone.extraFee })
  }

  const total = lines.reduce((s, l) => s + l.amount, 0)
  const pp = service.prepayment
  const prepayment =
    pp.type === 'percent' ? Math.round((total * pp.value) / 100) : Math.min(pp.value, total)

  return { lines, total, prepayment }
}
