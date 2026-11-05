import type { WeekSchedule } from './types'
import { weekdayKeyOfDate, zonedToUtcMs } from './time'

// Полная сетка слотов дня (свободные + занятые): «занятое время явно отмечено».
export function buildSlotGrid(schedule: WeekSchedule, date: string, stepMin = 30): number[] {
  const win = schedule[weekdayKeyOfDate(date)]
  if (!win) return []
  const [oh, om] = win.open.split(':').map(Number)
  const [ch, cm] = win.close.split(':').map(Number)
  const open = oh * 60 + (om || 0)
  const close = ch * 60 + (cm || 0)
  const out: number[] = []
  for (let m = open; m + stepMin <= close; m += stepMin) {
    out.push(m)
  }
  return out
}

export function gridMinutesToMs(tz: string, date: string, minutesOfDay: number): number {
  const h = String(Math.floor(minutesOfDay / 60)).padStart(2, '0')
  const m = String(minutesOfDay % 60).padStart(2, '0')
  return zonedToUtcMs(tz, date, `${h}:${m}`)
}
