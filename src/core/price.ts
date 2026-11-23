import type { Addon, Hall, Service, TravelZone, WeekSchedule } from './types'
import {
  addDaysToDateString,
  isWeekendDate,
  minutesOf,
  utcToZonedDate,
  utcToZonedTime,
  weekdayKeyOfDate,
  windowDurationMin,
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
  // специалисты почасовой услуги: отдельные строки «человеко-часы».
  // specialists — команда услуги (несколько), specialist — легаси-одиночка.
  specialists?: { name: string; hourRate: number }[] | null
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
  // Y1: ночное окно длится до следующего дня; длительность — windowDurationMin
  const totalMinutes = windows.reduce((s, w) => s + windowDurationMin(w.open, w.close), 0)
  const last = windows[windows.length - 1]
  const lastCloseMs = last
    ? zonedToUtcMs(tz, last.date, last.open) + windowDurationMin(last.open, last.close) * 60_000
    : startUtcMs
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
  const specialistRates = (input.specialists?.length
    ? input.specialists
    : input.specialist
      ? [input.specialist]
      : []
  ).filter((s) => s.hourRate > 0)

  // Тарифицируемые часы каждого окна: все полные часы окна (Y2 — зал занят
  // целиком, оплата за весь занятый ресурс). Одна сумма — на тариф, специалиста и аддоны.
  const hoursPerWindow = input.fullDayWindows
    ? input.fullDayWindows.map((w) => Math.floor(windowDurationMin(w.open, w.close) / 60))
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
      if (!hall && specialistRates.length === 0) {
        throw new Error('Для почасовой услуги нужен зал или специалист')
      }
      const perWindow = hoursPerWindow ?? []
      let rental = 0
      if (hall) {
        input.fullDayWindows.forEach((w, i) => {
          for (let h = 0; h < perWindow[i]; h++) {
            // Y1: час после полуночи принадлежит следующей календарной дате —
            // тариф выходного/буднего считается по фактической дате часа
            const hourStartMs = zonedToUtcMs(input.tz, w.date, w.open) + h * 3_600_000
            const date = utcToZonedDate(input.tz, hourStartMs)
            const time = utcToZonedTime(input.tz, hourStartMs)
            rental += hourRateFor(hall, date, time, input.eveningFrom ?? '18:00')
          }
        })
        lines.push({ label: `${service.name} · ${hall.name}`, amount: rental })
      }
      for (const sp of specialistRates) {
        lines.push({ label: `Специалист: ${sp.name}`, amount: sp.hourRate * windowsHours })
      }
    }
  } else if (service.priceType === 'fixed') {
    // кратность: клиент берёт абсолютную длительность — считаем целое число
    // базовых пакетов (5 ч при базе 2 ч → ×3), минимум один пакет
    const k = input.durationMin ? Math.max(1, Math.ceil(input.durationMin / service.durationMin)) : 1
    lines.push({ label: k > 1 ? `${service.name} × ${k}` : service.name, amount: service.price * k })
  } else {
    if (!hall && specialistRates.length === 0) {
      throw new Error('Для почасовой услуги нужен зал или специалист')
    }
    const hours = ceilHours(durationMin)
    if (hall) {
      let rental = 0
      for (let i = 0; i < hours; i++) {
        const hourStartMs = startUtcMs + i * 3_600_000
        const date = utcToZonedDate(tz, hourStartMs)
        const time = utcToZonedTime(tz, hourStartMs)
        rental += hourRateFor(hall, date, time, input.eveningFrom ?? '18:00')
      }
      lines.push({ label: `${service.name} · ${hall.name}`, amount: rental })
    }
    for (const sp of specialistRates) {
      lines.push({ label: `Специалист: ${sp.name}`, amount: sp.hourRate * hours })
    }
  }

  // часы почасовых аддонов: при «весь день» — все полные часы окон (Y2),
  // иначе — часы от длительности
  const hours = input.fullDayWindows?.length ? windowsHours : ceilHours(durationMin)
  for (const id of input.selectedAddonIds) {
    const addon = input.addons.find((a) => a.id === id)
    if (!addon) continue
    // допы принадлежат услуге: только services.addonIds (пусто/NULL — допов
    // нет). Легаси-фолбэк по appliesTo удалён: он протаскивал в аренду зала
    // допуслуги съёмок (баг «в аренде чужие допы»)
    if (!input.service.addonIds?.includes(addon.id)) continue
    // белый список залов допа: непустой — только для этих залов; бронь без
    // зала (выезд/услуга без зала) такие допы не получает
    if (addon.hallIds?.length && (!input.hall || !addon.hallIds.includes(input.hall.id))) continue
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
  // Защита от старых конфигураций вида «2000%»: предоплата физически
  // не может быть больше стоимости заявки.
  const calculatedPrepayment =
    pp.type === 'percent' ? Math.round((total * pp.value) / 100) : Math.min(pp.value, total)
  const prepayment = Math.min(calculatedPrepayment, total)

  return { lines, total, prepayment }
}
