import { formatInTimeZone } from 'date-fns-tz'
import { ru } from 'date-fns/locale'
import type { WeekSchedule } from '@/core/types'

export const money = (n: number) => n.toLocaleString('ru-RU') + ' ₽'

// Z1: русская локаль — month names и дни недели («19 ноября 2026, четверг»)
export function dtInTz(tz: string, ms: number, fmt = 'd MMMM, HH:mm'): string {
  return formatInTimeZone(new Date(ms), tz, fmt, { locale: ru })
}

export function dateInTz(tz: string, ms: number): string {
  return formatInTimeZone(new Date(ms), tz, 'yyyy-MM-dd')
}

export function timeInTz(tz: string, ms: number): string {
  return formatInTimeZone(new Date(ms), tz, 'HH:mm')
}

// Z1: русская локаль; «июня.» → «июня» (date-fns-ru не ставит точку, replace оставляем страховкой)
export function humanDate(tz: string, ms: number): string {
  return formatInTimeZone(new Date(ms), tz, 'd MMMM yyyy, EEEE', { locale: ru }).replace('.', '')
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
    value: schedule[k]
      ? // Y1: ночная смена помечается «до следующего дня», чтобы 22:00–06:00
        // не читалось как опечатка
        `${schedule[k]!.open}–${schedule[k]!.close}${schedule[k]!.close <= schedule[k]!.open ? ' (до следующего дня)' : ''}`
      : 'выходной',
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

// Z2: время окончания брони. Ночная бронь кончается на следующие сутки —
// показываем дату, чтобы «пятница, 22:00–06:00» не читалось как «утро пятницы».
export function endInTz(tz: string, startMs: number, endMs: number): string {
  const sameDay = dateInTz(tz, startMs) === dateInTz(tz, endMs)
  return sameDay ? timeInTz(tz, endMs) : `${timeInTz(tz, endMs)} след. дня`
}
