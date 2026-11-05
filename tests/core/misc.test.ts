import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateTenantConfig } from '@/core/schema'
import { buildIcs } from '@/lib/ics'
import { toCsv } from '@/lib/csv'

describe('tenant config', () => {
  it('принимает валидный конфиг демо-студии', () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, '../../tenants/anna-vetrova/tenant.json'), 'utf8'))
    const cfg = validateTenantConfig(raw)
    expect(cfg.settings.slug).toBe('anna-vetrova')
  })
  it('отклоняет битый конфиг', () => {
    expect(() => validateTenantConfig({ settings: {} })).toThrow()
  })
})

describe('ics', () => {
  it('собирает валидный VEVENT с экранированием', () => {
    const ics = buildIcs({
      title: 'Съёмка, портрет; тест',
      startMs: new Date('2026-11-02T07:00:00Z').getTime(),
      endMs: new Date('2026-11-02T08:00:00Z').getTime(),
      location: 'Казань, ул. Примерная',
    })
    expect(ics).toContain('BEGIN:VCALENDAR')
    expect(ics).toContain('DTSTART:20261102T070000Z')
    expect(ics).toContain('SUMMARY:Съёмка\\, портрет\\; тест')
  })
})

describe('csv', () => {
  it('экранирует разделители и добавляет BOM', () => {
    const csv = toCsv([{ Имя: 'Мария; Анна', Сумма: 5000 }])
    expect(csv.startsWith('\ufeff')).toBe(true)
    expect(csv).toContain('"Мария; Анна"')
  })
})
