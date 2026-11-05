import { formatInTimeZone } from 'date-fns-tz'
import type { WeekSchedule } from '@/core/types'

export const money = (n: number) => n.toLocaleString('ru-RU') + ' ₽'

export function dtInTz(tz: string, ms: number, fmt = 'd MMMM, HH:mm'): string {
  return formatInTimeZone(new Date(ms), tz, fmt, { locale: undefined })
}

export function dateInTz(tz: string, ms: number): string {
  return formatInTimeZone(new Date(ms), tz, 'yyyy-MM-dd')
}

export function timeInTz(tz: string, ms: number): string {
  return formatInTimeZone(new Date(ms), tz, 'HH:mm')
}

export function humanDate(tz: string, ms: number): string {
  return formatInTimeZone(new Date(ms), tz, 'd MMMM yyyy, EEEE').replace('.', '')
}

export const WEEKDAY_RU: Record<string, string> = {
  mon: 'Понедельник',
  tue: 'Вторник',
  wed: 'Среда',
  thu: 'Четверг',
  fri: 'Пятница',
  sat: 'Суббота',
  sun: 'Воскресенье',
}

export const WEEKDAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

export function scheduleRows(schedule: WeekSchedule) {
  return WEEKDAY_ORDER.map((k) => ({
    key: k,
    label: WEEKDAY_RU[k],
    value: schedule[k] ? `${schedule[k]!.open}–${schedule[k]!.close}` : 'выходной',
  }))
}

export function slotWord(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

export function hoursLabel(n: number): string {
  return `${n} ${slotWord(n, 'час', 'часа', 'часов')}`
}
