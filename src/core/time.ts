import { zonedTimeToUtc, formatInTimeZone } from 'date-fns-tz'

export type BusyResourceType = 'specialist' | 'hall'

export interface BusyInterval {
  resourceType: BusyResourceType
  resourceId: string
  startMs: number
  endMs: number
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
