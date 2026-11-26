import { zonedTimeToUtc, formatInTimeZone } from 'npm:date-fns-tz'

export type BusyResourceType = 'specialist' | 'hall'

export interface TimeInterval {
  startMs: number
  endMs: number
}

export interface BusyInterval extends TimeInterval {
  resourceType: BusyResourceType
  resourceId: string
}

export function zonedToUtcMs(tz: string, date: string, time: string): number {
  return zonedTimeToUtc(`${date} ${time}`, tz).getTime()
}

export function utcToZonedDate(tz: string, ms: number): string {
  return formatInTimeZone(new Date(ms), tz, 'yyyy-MM-dd')
}

export function utcToZonedTime(tz: string, ms: number): string {
  return formatInTimeZone(new Date(ms), tz, 'HH:mm')
}

export function utcToZonedWeekday(tz: string, ms: number): WeekdayKey {
  const fmt = formatInTimeZone(new Date(ms), tz, 'ccc').toLowerCase()
  const map: Record<string, WeekdayKey> = {
    mon: 'mon',
    tue: 'tue',
    wed: 'wed',
    thu: 'thu',
    fri: 'fri',
    sat: 'sat',
    sun: 'sun',
  }
  return map[fmt] ?? 'mon'
}

export function addMinutes(ms: number, minutes: number): number {
  return ms + minutes * 60_000
}

export function addDaysToDateString(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + (m || 0)
}

// Y1: окно «через полночь»: смена 22:00–06:00 длится 8 ч, а не −16.
// close <= open означает конец на следующие сутки; совпадение начала и конца
// считается некорректным окном длительностью 0 (zod его отклоняет).
export function windowDurationMin(open: string, close: string): number {
  const o = minutesOf(open)
  const c = minutesOf(close)
  if (c === o) return 0
  return c > o ? c - o : c + 24 * 60 - o
}

export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd
}

export function intersectInterval(a: BusyInterval, startMs: number, endMs: number): boolean {
  return overlaps(a.startMs, a.endMs, startMs, endMs)
}

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export function weekdayKeyOfDate(date: string): WeekdayKey {
  const keys: WeekdayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const d = new Date(date + 'T00:00:00Z')
  return keys[d.getUTCDay()]
}

export function isWeekendDate(date: string): boolean {
  const k = weekdayKeyOfDate(date)
  return k === 'sat' || k === 'sun'
}

export { utcToZonedTime as toZoned }

// Строгая гражданская дата: «2026-02-30» через new Date превращается в 2 марта,
// поэтому сравниваем компоненты после обратного преобразования.
export function isValidCivilDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

export function isValidTimeHHmm(hhmm: string): boolean {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return false
  return Number(m[1]) <= 23 && Number(m[2]) <= 59
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('ru', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
