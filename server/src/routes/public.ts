import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler, badRequest, notFound } from '../middleware/errors'
import { rateLimit } from '../middleware/rateLimit'
import { config } from '../config'
import { getStudioBySlug, loadStudioBundle } from '../services/catalog'
import { getSlots } from '../services/availability'
import { cancelByToken, createPublicBooking, findDuplicate, getBookingByTokenHash } from '../services/bookings'
import { deletePushSubscription, savePushSubscription } from '../services/push'
import { runAssistant } from '../services/assistant'
import { infoByToken } from '../services/invitations'
import { createBookingSchema } from '../../../src/core/schema'

export const publicRouter = Router()

// Витрина: StudioBundle без calendarToken (токен календаря не публичный).
publicRouter.get(
  '/studios/:slug',
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    res.json(await loadStudioBundle(studio.id, studio.slug))
  })
)

publicRouter.post(
  '/studios/:slug/availability',
  rateLimit('avail', 60),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    const body = z
      .object({
        serviceId: z.string().min(1),
        dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        dayCount: z.number().int().min(1).max(5).optional(),
        durationMin: z.number().int().min(30).max(24 * 60).optional(),
        specialistId: z.string().nullable().optional(),
        hallId: z.string().nullable().optional(),
        offsite: z.boolean().optional(),
        travelZoneId: z.string().nullable().optional(),
        peopleCount: z.number().int().min(1).max(200).optional(),
      })
      .parse(req.body)
    const bundle = await loadStudioBundle(studio.id, studio.slug)
    const result = await getSlots({
      studioId: studio.id,
      settings: bundle.settings,
      specialists: bundle.specialists,
      halls: bundle.halls,
      services: bundle.services,
      serviceId: body.serviceId,
      dateFrom: body.dateFrom,
      dayCount: body.dayCount,
      durationMin: body.durationMin,
      specialistId: body.specialistId ?? null,
      hallId: body.hallId ?? null,
      offsite: body.offsite ?? false,
      travelZoneId: body.travelZoneId ?? null,
      peopleCount: body.peopleCount,
    })
    res.json({ slots: result.slots, reason: result.reason ?? null })
  })
)

publicRouter.post(
  '/studios/:slug/bookings',
  rateLimit('book', 10),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    const bundle = await loadStudioBundle(studio.id, studio.slug)
    const parsed = createBookingSchema.parse({ ...req.body, slug: req.params.slug })
    const { slug: _slug, ...payload } = parsed
    if (payload.honeypot) throw badRequest('Заявка отклонена')

    // Идемпотентность: повтор возвращает существующую заявку без нового токена.
    // Секрет хранится только хешем, поэтому токен был выдан лишь в первом ответе
    // (фронтенд сохраняет его в bookingStorage сразу после первого успеха).
    const duplicate = await findDuplicate(studio.id, studio.slug, payload.idempotencyKey)
    if (duplicate) {
      res.json({ ok: true, duplicate: true })
      return
    }

    const service = bundle.services.find((s) => s.id === payload.serviceId)
    if (!service) throw badRequest('Услуга не найдена')
    if (payload.kind !== service.kind) throw badRequest('Тип услуги не совпадает')
    // почасовая услуга физически занимает зал — зал обязателен даже без галки
    const needHall = service.needsHall || service.priceType === 'hourly'
    // белый список залов услуги: пусто/undefined — любой активный зал
    const allowedHalls = bundle.halls.filter(
      (h) => h.active && (!service.hallIds?.length || service.hallIds.includes(h.id))
    )
    const hall = needHall ? allowedHalls.find((h) => h.id === payload.hallId) ?? null : null
    if (needHall && payload.hallId && !hall) throw badRequest('Зал недоступен для этой услуги')
    const allowedSpecs = bundle.specialists.filter(
      (s) => s.active && (!service.specialistIds?.length || service.specialistIds.includes(s.id))
    )
    if (payload.specialistId && !allowedSpecs.some((s) => s.id === payload.specialistId)) {
      throw badRequest('Специалист недоступен для этой услуги')
    }
    if (!service.needsSpecialist && payload.specialistId) {
      // иначе заявка молча блокировала бы ресурс чужого специалиста
      throw badRequest('Эта услуга не требует выбора специалиста')
    }
    if (service.maxPeople && (payload.peopleCount ?? 1) > service.maxPeople) {
      throw badRequest(`Максимум людей для этой услуги — ${service.maxPeople}`)
    }

    const result = await createPublicBooking({
      studioId: studio.id,
      slug: studio.slug,
      settings: bundle.settings,
      service,
      hall,
      halls: allowedHalls,
      addons: bundle.addons,
      specialists: bundle.specialists,
      payload,
    })
    res.json(result)
  })
)

// Доступ к своей заявке по секрету из ссылки; хеш/токен в ответ не попадают.
// rate-limit: без него токен-lookup — неограниченный sha256-перебор по БД
publicRouter.get(
  '/studios/:slug/bookings/:token',
  rateLimit('avail', 60),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    const record = await getBookingByTokenHash(studio.id, studio.slug, req.params.token)
    if (!record) throw notFound('Запись не найдена')
    res.json(record)
  })
)

publicRouter.post(
  '/studios/:slug/bookings/:token/cancel',
  rateLimit('avail', 60),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    const result = await cancelByToken(studio.id, studio.slug, req.params.token, studio.settings)
    res.json(result)
  })
)

publicRouter.post(
  '/studios/:slug/assistant',
  rateLimit('assistant-pub', 10),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    const { message } = z.object({ message: z.string().min(1).max(1000) }).parse(req.body)
    const bundle = await loadStudioBundle(studio.id, studio.slug)
    const result = await runAssistant({
      studio: {
        id: studio.id,
        slug: studio.slug,
        settings: bundle.settings,
        specialists: bundle.specialists,
        halls: bundle.halls,
        services: bundle.services,
        addons: bundle.addons,
      },
      message,
      kind: 'client',
    })
    res.json(result)
  })
)

// ---------- Web Push витрины (подписки клиентов студии) ----------

// VAPID publicKey для браузерной подписки; null = push не настроен (витрина молча выключает)
publicRouter.get(
  '/studios/:slug/push-key',
  rateLimit('avail', 60),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    res.json({ publicKey: config.VAPID_PUBLIC_KEY ?? null })
  })
)

const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
})

publicRouter.post(
  '/studios/:slug/push-subscribe',
  rateLimit('book', 10),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    const body = pushSubscribeSchema.parse(req.body)
    await savePushSubscription(studio.id, body)
    res.status(204).end()
  })
)

publicRouter.post(
  '/studios/:slug/push-unsubscribe',
  rateLimit('book', 10),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    const body = z.object({ endpoint: z.string().url().max(2048) }).parse(req.body)
    await deletePushSubscription(studio.id, body.endpoint)
    res.status(204).end()
  })
)

// Данные страницы активации приглашения /invite/<токен> (публично: гость не залогинен).
// Путь /api/invitations/info — ровно как в контракте ТЗ и во фронтовом адаптере.
export const invitationsRouter = Router()

invitationsRouter.get(
  '/info',
  asyncHandler(async (req, res) => {
    const token = String(req.query.token ?? '')
    res.json(await infoByToken(token))
  })
)
