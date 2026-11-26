import { z } from 'npm:zod'
import type { TenantConfig } from './types'
import { windowDurationMin, isValidCivilDate, isValidTimeHHmm, isValidTimeZone } from './time'

// часы 00–23 и минуты 00–59: одного формата мало, «19:75» проходило
const hhmmSchema = z.string().regex(/^\d{2}:\d{2}$/).refine(isValidTimeHHmm, 'Часы 00–23, минуты 00–59')

export const weeklyWindowSchema = z
  .object({ open: hhmmSchema, close: hhmmSchema })
  .refine((w) => windowDurationMin(w.open, w.close) <= 24 * 60, {
    message: 'Смена не может длиться больше 24 часов',
  })
  .refine((w) => windowDurationMin(w.open, w.close) > 0, {
    message: 'Открытие и закрытие не могут совпадать',
  })
  .nullable()

// Проценты и рубли легко перепутать в настройках: «2000%» превращали предоплату
// в абсурд. Сумма может быть больше итога (ядро ограничит её итогом),
// а процент больше 100 — всегда ошибка конфигурации.
export const prepaymentSchema = z
  .object({ type: z.enum(['percent', 'amount']), value: z.number().int().min(0) })
  .superRefine((pp, ctx) => {
    if (pp.type === 'percent' && pp.value > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: 100,
        inclusive: true,
        type: 'number',
        path: ['value'],
        message: 'Процент предоплаты не может быть больше 100',
      })
    }
  })

export const tenantSettingsSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(1).max(120),
  tagline: z.string().max(200).default(''),
  description: z.string().max(4000).default(''),
  city: z.string().min(1),
  address: z.string().default(''),
  mapsUrl: z.string().url().default('https://yandex.ru/maps/'),
  phone: z.string().min(5),
  contactMethods: z
    .array(z.object({ type: z.enum(['telegram', 'whatsapp', 'vk', 'max', 'phone']), value: z.string() }))
    // B-31: у MAX свободный текст превращался в нерабочую кнопку —
    // принимаем только @username или ссылку max.ru/…
    .superRefine((methods, ctx) => {
      methods.forEach((m, i) => {
        if (m.type !== 'max') return
        if (/^(https?:\/\/)?(www\.)?max\.ru\/[A-Za-z0-9_.]+\/?$|^@?[A-Za-z0-9_.]+$/.test(m.value)) return
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'value'],
          message: 'Ссылка MAX: укажите @username или ссылку max.ru/…',
        })
      })
    })
    .default([]),
  tz: z.string().refine(isValidTimeZone, 'Неизвестная таймзона').default('Europe/Moscow'),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#b4552d'),
  theme: z.enum(['light', 'dark', 'auto']).default('light'),
  modes: z.object({ shoots: z.boolean(), rental: z.boolean() }).default({ shoots: true, rental: false }),
  status: z.enum(['demo', 'active']).default('demo'),
  // график обязан содержать все 7 дней (значение null = выходной): без ключа
  // день считался открытым, и расчёт слотов падал
  schedule: z.record(weeklyWindowSchema).superRefine((sch, ctx) => {
    for (const key of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const) {
      if (!(key in sch)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'В графике нужны все 7 дней' })
    }
  }),
  closedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidCivilDate, 'Некорректная дата')).default([]),
  cancellation: z.object({ freeHours: z.number().int().min(0).max(336), text: z.string() }).default({ freeHours: 48, text: '' }),
  prepaymentDefault: prepaymentSchema.default({ type: 'percent', value: 30 }),
  travelZones: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(120),
        minutesBefore: z.number().int().min(0).max(12 * 60),
        minutesAfter: z.number().int().min(0).max(12 * 60),
        extraFee: z.number().int().min(0).max(1_000_000),
      })
    )
    .max(10)
    .refine((zones) => new Set(zones.map((z) => z.id)).size === zones.length, {
      message: 'Идентификаторы зон выезда должны быть уникальными',
    })
    .default([]),
  infoCards: z.array(z.object({ icon: z.string(), title: z.string(), text: z.string() })).max(3).default([]),
  reviews: z.array(z.object({ author: z.string(), rating: z.number().int().min(1).max(5), text: z.string() })).default([]),
  reviewsEnabled: z.boolean().default(false),
  teamEnabled: z.boolean().default(false),
  teamCardStyle: z.enum(['card', 'photo', 'minimal']).default('card'),
  specialistChoiceVisible: z.boolean().default(true),
  hallChoiceVisible: z.boolean().default(true),
  serviceCardSize: z.enum(['compact', 'normal', 'large']).default('normal'),
  hallCardSize: z.enum(['compact', 'normal', 'large']).default('normal'),
  sectionsOrder: z.array(z.enum(['about', 'team', 'works', 'services', 'info', 'reviews', 'contacts'])).optional(),
  heroPhotoId: z.string().optional(),
  // не .url(): кроме загрузки допустим путь tenant.json (photos/hero.jpg)
  heroPhotoUrl: z.string().max(2048).optional(),
  // B-69: только regex недостаточно — «19:75» проходит формат, но не валидно.
  // Проверяем диапазон часов/минут через isValidTimeHHmm.
  eveningFrom: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .refine(isValidTimeHHmm, 'Часы 00–23, минуты 00–59')
    .default('18:00'),
})

export const tenantConfigSchema = z.object({
  settings: tenantSettingsSchema,
  specialists: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        title: z.string().default(''),
        active: z.boolean().default(true),
        dayLimit: z.number().int().min(1).max(10).default(1),
        photoUrl: z.string().optional(),
        showOnTeam: z.boolean().default(true),
        schedule: z.record(weeklyWindowSchema).optional(),
        hourRate: z.number().int().min(0).optional(),
      })
    )
    .default([]),
  halls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        capacity: z.number().int().min(1),
        rates: z.object({
          weekday: z.object({ day: z.number().int(), evening: z.number().int() }),
          weekend: z.object({ day: z.number().int(), evening: z.number().int() }),
        }),
        active: z.boolean().default(true),
        photos: z.array(z.string()).default([]),
      })
    )
    .default([]),
  services: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(['shoot', 'rental']),
        name: z.string(),
        description: z.string().default(''),
        priceType: z.enum(['fixed', 'hourly']),
        price: z.number().int().min(0).default(0),
        durationMin: z.number().int().min(30),
        includes: z.array(z.string()).default([]),
        deliverableText: z.string().default(''),
        deadlineDays: z.number().int().min(0).default(7),
        prepayment: prepaymentSchema,
        needsSpecialist: z.boolean().default(false),
        needsHall: z.boolean().default(false),
        defaultHallId: z.string().optional(),
        hallIds: z.array(z.string()).optional(),
        specialistIds: z.array(z.string()).optional(),
        allSpecialistsRequired: z.boolean().optional(),
        addonIds: z.array(z.string()).optional(),
        maxPeople: z.number().int().min(1).optional(),
        referencesEnabled: z.boolean().optional(),
        photoUrl: z.string().optional(),
        fullDay: z.boolean().default(false),
        multiDayMax: z.number().int().min(1).max(5).default(1),
        autoConfirm: z.boolean().default(false),
        setupMin: z.number().int().min(0).default(0),
        cleanupMin: z.number().int().min(0).default(0),
        sort: z.number().int().default(0),
      })
    )
    .min(1),
  addons: z
    .array(
      z.object({
        id: z.string(),
        appliesTo: z.enum(['shoot', 'rental', 'both']),
        name: z.string(),
        price: z.number().int().min(0),
        unit: z.enum(['booking', 'hour', 'person']),
        hallIds: z.array(z.string()).optional(),
      })
    )
    .default([]),
  portfolio: z
    .array(
      z.object({
        id: z.string(),
        category: z.string(),
        caption: z.string().default(''),
        kind: z.enum(['image', 'video']).default('image'),
        videoUrl: z.string().optional(),
        src: z.string(),
        srcset: z.string().optional(),
        sort: z.number().int().default(0),
      })
    )
    .default([]),
  seedBookings: z
    .array(
      z.object({
        startsAt: z.string().datetime(),
        endsAt: z.string().datetime(),
        specialistId: z.string().optional(),
        hallId: z.string().optional(),
        summary: z.string().default('Занято'),
      })
    )
    .default([]),
})

export function validateTenantConfig(data: unknown): TenantConfig {
  const parsed = tenantConfigSchema.parse(data)
  return parsed as TenantConfig
}

export const createBookingSchema = z
  .object({
    slug: z.string().min(2),
    kind: z.enum(['shoot', 'rental']),
    serviceId: z.string().min(1),
    specialistId: z.string().nullable().optional(),
    hallId: z.string().nullable().optional(),
    startUtcMs: z.number().int().positive(),
    durationMin: z.number().int().min(30).max(24 * 60).optional(),
    dayCount: z.number().int().min(1).max(5).optional(),
    peopleCount: z.number().int().min(1).max(200).optional(),
    offsite: z.boolean().optional(),
    travelZoneId: z.string().nullable().optional(),
    addonIds: z.array(z.string()).max(10).optional(),
    client: z.object({
      name: z.string().min(2).max(120),
      phone: z.string().min(10).max(20),
      method: z.enum(['telegram', 'whatsapp', 'vk', 'max', 'phone']),
      notes: z.string().max(2000).optional(),
      referenceCount: z.number().int().min(0).max(5).optional(),
    }),
    consent: z.boolean().refine((v) => v === true, 'Требуется согласие на обработку данных'),
    honeypot: z.string().max(0).optional(),
    idempotencyKey: z.string().min(8).max(64),
  })
  .strict()

export type CreateBookingPayload = z.infer<typeof createBookingSchema>
