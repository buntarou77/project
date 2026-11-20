import type { WeekSchedule } from './types'
import { addDaysToDateString, minutesOf, weekdayKeyOfDate, windowDurationMin, zonedToUtcMs } from './time'

// Полная сетка слотов дня (свободные + занятые): «занятое время явно отмечено».
export function buildSlotGrid(schedule: WeekSchedule, date: string, stepMin = 30): number[] {
  const win = schedule[weekdayKeyOfDate(date)]
  if (!win) return []
  const open = minutesOf(win.open)
  // Y1: ночная смена — слоты уходят за 24:00 (1440 мин — полночь), значения
  // больше 1439 означают время следующего дня; gridMinutesToMs переводит их
  // в UTC корректно (дата + переполнение часов)
  const close = open + windowDurationMin(win.open, win.close)
  const out: number[] = []
  for (let m = open; m + stepMin <= close; m += stepMin) {
    out.push(m)
  }
  return out
}

export function gridMinutesToMs(tz: string, date: string, minutesOfDay: number): number {
  // Y1: минуты могут превышать сутки (ночная смена) — дата сдвигается,
  // остаток — время следующего дня
  const day = addDaysToDateString(date, Math.floor(minutesOfDay / (24 * 60)))
  const rest = minutesOfDay % (24 * 60)
  const h = String(Math.floor(rest / 60)).padStart(2, '0')
  const m = String(rest % 60).padStart(2, '0')
  return zonedToUtcMs(tz, day, `${h}:${m}`)
}
