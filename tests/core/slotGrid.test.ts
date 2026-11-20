import { describe, expect, it } from 'vitest'
import { buildSlotGrid, gridMinutesToMs } from '@/core/slotGrid'
import { zonedToUtcMs } from '@/core/time'
import type { WeekSchedule } from '@/core/types'

const TZ = 'Europe/Moscow'
const MON = '2026-11-02'

const schedule: WeekSchedule = {
  mon: { open: '10:00', close: '21:00' },
  tue: { open: '10:00', close: '21:00' },
  wed: { open: '10:00', close: '21:00' },
  thu: { open: '10:00', close: '21:00' },
  fri: { open: '10:00', close: '21:00' },
  sat: { open: '10:00', close: '20:00' },
  sun: null,
}

describe('buildSlotGrid', () => {
  it('полная сетка дня со шагом 30 минут', () => {
    const grid = buildSlotGrid(schedule, '2026-11-02') // понедельник 10:00–21:00
    expect(grid).toHaveLength(22)
    expect(grid[0]).toBe(600)
    expect(grid[grid.length - 1]).toBe(1230)
  })

  it('выходной — пустая сетка', () => {
    expect(buildSlotGrid(schedule, '2026-11-01')).toHaveLength(0) // воскресенье
  })

  it('перевод минут дня в UTC по таймзоне студии', () => {
    const ms = gridMinutesToMs('Europe/Moscow', '2026-11-02', 600) // 10:00 МСК
    expect(new Date(ms).toISOString()).toBe('2026-11-02T07:00:00.000Z')
  })

  it('ночная смена: сетка уходит за полночь', () => {
    const night: WeekSchedule = { ...schedule, mon: { open: '22:00', close: '06:00' } }
    const grid = buildSlotGrid(night, MON, 60)
    expect(grid[0]).toBe(22 * 60)
    expect(grid[grid.length - 1]).toBe(22 * 60 + 7 * 60) // последний слот 05:00
    expect(grid).toHaveLength(8)
  })

  it('gridMinutesToMs: минуты следующего дня переходят в правильную дату', () => {
    const ms = gridMinutesToMs(TZ, MON, 24 * 60 + 120) // вторник 02:00
    expect(ms).toBe(zonedToUtcMs(TZ, '2026-11-03', '02:00'))
  })
})
