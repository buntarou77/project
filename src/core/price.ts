import type { Addon, Hall, Service, TravelZone } from './types'
import { isWeekendDate, minutesOf, utcToZonedDate, utcToZonedTime } from './time'

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
  const durationMin =
    input.durationMin ?? (service.priceType === 'hourly' ? service.durationMin : service.durationMin)
  const people = Math.max(1, input.peopleCount ?? 1)
  const lines: PriceLine[] = []

  if (service.priceType === 'fixed') {
    lines.push({ label: service.name, amount: service.price })
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
  }

  const hours = ceilHours(durationMin)
  for (const id of input.selectedAddonIds) {
    const addon = input.addons.find((a) => a.id === id)
    if (!addon) continue
    if (addon.appliesTo !== 'both' && addon.appliesTo !== service.kind) continue
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
