import { describe, it, expect } from 'vitest'
import { endInTz, humanDate } from '@/ui/format'
import { zonedToUtcMs } from '@/core/time'

const TZ = 'Europe/Moscow'

describe('Z1/Z2: формат дат', () => {
  it('humanDate — русская локаль', () => {
    // 19.11.2026 — четверг
    const ms = zonedToUtcMs(TZ, '2026-11-19', '12:00')
    expect(humanDate(TZ, ms)).toBe('19 ноября 2026, четверг')
  })

  it('endInTz: конец в те же сутки — только время', () => {
    const s = zonedToUtcMs(TZ, '2026-11-19', '10:00')
    expect(endInTz(TZ, s, s + 2 * 3_600_000)).toBe('12:00')
  })

  it('endInTz: ночная бронь — «след. дня»', () => {
    const s = zonedToUtcMs(TZ, '2026-11-19', '22:00') // четверг вечер
    const e = zonedToUtcMs(TZ, '2026-11-20', '06:00') // пятница утро
    expect(endInTz(TZ, s, e)).toBe('06:00 след. дня')
  })
})
