import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { prepaymentSchema, tenantSettingsSchema, validateTenantConfig } from '@/core/schema'
import { buildIcs } from '@/lib/ics'
import { toCsv } from '@/lib/csv'
import { heroImageFor } from '@/ui/hero'
import type { PortfolioItem, TenantSettings } from '@/core/types'

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

describe('prepayment schema', () => {
  it('принимает 100% и сумму', () => {
    expect(prepaymentSchema.safeParse({ type: 'percent', value: 100 }).success).toBe(true)
    expect(prepaymentSchema.safeParse({ type: 'amount', value: 2000 }).success).toBe(true)
  })

  it('отклоняет процент больше 100 (ошибка «2000 ₽» в поле процентов)', () => {
    const parsed = prepaymentSchema.safeParse({ type: 'percent', value: 2000 })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0].message).toContain('больше 100')
    }
  })
})

describe('travel zones schema', () => {
  const city = { id: 'city', name: 'Выезд по городу', minutesBefore: 0, minutesAfter: 0, extraFee: 1000 }
  const suburb = { id: 'suburb', name: 'Выезд за город', minutesBefore: 60, minutesAfter: 60, extraFee: 3000 }

  it('принимает город и загород с фиксированными сборами', () => {
    const schema = tenantSettingsSchema.pick({ travelZones: true })
    expect(schema.safeParse({ travelZones: [city, suburb] }).success).toBe(true)
  })

  it('отклоняет дубликаты id и отрицательный сбор', () => {
    const schema = tenantSettingsSchema.pick({ travelZones: true })
    expect(schema.safeParse({ travelZones: [city, { ...city, name: 'второй' }] }).success).toBe(false)
    expect(schema.safeParse({ travelZones: [{ ...city, extraFee: -1 }] }).success).toBe(false)
  })
})

describe('hero photo settings', () => {
  it('heroPhotoUrl необязателен: URL загрузки и относительный путь tenant.json проходят, длинный/не-строка — нет', () => {
    const schema = tenantSettingsSchema.pick({ heroPhotoId: true, heroPhotoUrl: true })
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ heroPhotoUrl: 'http://localhost:3000/uploads/st-1/hero/a.jpg' }).success).toBe(true)
    expect(schema.safeParse({ heroPhotoUrl: 'photos/hero.jpg' }).success).toBe(true)
    expect(schema.safeParse({ heroPhotoUrl: 'x'.repeat(2049) }).success).toBe(false)
    expect(schema.safeParse({ heroPhotoUrl: 42 }).success).toBe(false)
    expect(schema.safeParse({ heroPhotoUrl: null }).success).toBe(false)
  })

  it('heroImageFor: своё фото важнее heroPhotoId; без него — интерьер, затем первая работа', () => {
    const st = (patch: Partial<TenantSettings>) => patch as TenantSettings
    const item = (id: string, category: string): PortfolioItem => ({ id, category, caption: '', kind: 'image', src: `/${id}.jpg`, sort: 1 })
    const portfolio = [item('p1', 'портрет'), item('p2', 'интерьер студии')]
    // своё фото — без srcset портфолио
    expect(heroImageFor(st({ heroPhotoUrl: '/hero.jpg', heroPhotoId: 'p2' }), portfolio)).toStrictEqual({ src: '/hero.jpg' })
    expect(heroImageFor(st({ heroPhotoId: 'p1' }), portfolio)).toEqual({ src: '/p1.jpg' })
    expect(heroImageFor(st({}), portfolio)).toEqual({ src: '/p2.jpg' })
    // выбранный id удалили из портфолио — падаем назад на ту же цепочку
    expect(heroImageFor(st({ heroPhotoId: 'missing' }), [portfolio[0]])).toEqual({ src: '/p1.jpg' })
    expect(heroImageFor(st({}), [])).toBeNull()
    // пустая строка из старого JSON — как «не задано»
    expect(heroImageFor(st({ heroPhotoUrl: '', heroPhotoId: 'p1' }), portfolio)).toEqual({ src: '/p1.jpg' })
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

  it('П11: пустой список с явными заголовками не даёт пустой файл', () => {
    const csv = toCsv([], ['Дата', 'Время', 'Услуга'])
    expect(csv).toBe('\ufeffДата;Время;Услуга')
  })

  it('формула из публичной формы не исполняется в Excel: ячейка оборачивается в строковый литерал', () => {
    const csv = toCsv([{ Клиент: '=HYPERLINK("http://evil")', Телефон: '+79001234567' }])
    const cells = csv.split('\n')[1].split(';')
    // первая ячейка в CSV-кавычках — раскрываем удвоенные кавычки
    expect(cells[0].slice(1, -1).replace(/""/g, '"')).toBe('="=HYPERLINK(""http://evil"")"')
    expect(cells[1]).toBe('+79001234567') // телефон не трогаем
  })
})
