import { z } from 'zod'
import type { TenantConfig } from './types'

export const weeklyWindowSchema = z
  .object({ open: z.string().regex(/^\d{2}:\d{2}$/), close: z.string().regex(/^\d{2}:\d{2}$/) })
  .nullable()

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
    .default([]),
  tz: z.string().default('Europe/Moscow'),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0f766e'),
  theme: z.enum(['light', 'dark', 'auto']).default('light'),
  modes: z.object({ shoots: z.boolean(), rental: z.boolean() }).default({ shoots: true, rental: false }),
  status: z.enum(['demo', 'active']).default('demo'),
  schedule: z.record(weeklyWindowSchema),
  closedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  cancellation: z.object({ freeHours: z.number().int().min(0).max(336), text: z.string() }).default({ freeHours: 48, text: '' }),
  prepaymentDefault: z
    .object({ type: z.enum(['percent', 'amount']), value: z.number().int().min(0) })
    .default({ type: 'percent', value: 30 }),
  travelZones: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        minutesBefore: z.number().int().min(0),
        minutesAfter: z.number().int().min(0),
        extraFee: z.number().int().min(0),
      })
    )
    .default([]),
  infoCards: z.array(z.object({ icon: z.string(), title: z.string(), text: z.string() })).max(3).default([]),
  reviews: z.array(z.object({ author: z.string(), rating: z.number().int().min(1).max(5), text: z.string() })).default([]),
  reviewsEnabled: z.boolean().default(false),
  eveningFrom: z.string().regex(/^\d{2}:\d{2}$/).default('18:00'),
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
        prepayment: z.object({ type: z.enum(['percent', 'amount']), value: z.number().int().min(0) }),
        needsSpecialist: z.boolean().default(false),
        needsHall: z.boolean().default(false),
        defaultHallId: z.string().optional(),
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
