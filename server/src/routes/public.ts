import { Router } from 'express'
import path from 'node:path'
import { z } from 'zod'
import { asyncHandler, badRequest, notFound } from '../middleware/errors'
import { rateLimit } from '../middleware/rateLimit'
import { config } from '../config'
import { query } from '../db'
import { getStudioBySlug, loadStudioBundle } from '../services/catalog'
import { getSlots } from '../services/availability'
import { offsiteRequiredFor } from '../../../src/core/availability'
import { isValidCivilDate } from '../../../src/core/time'
import { cancelByToken, createPublicBooking, findDuplicate, getBookingByTokenHash, listReferences, saveReferenceFiles } from '../services/bookings'
import { deletePushSubscription, savePushSubscription } from '../services/push'
import { runAssistant } from '../services/assistant'
import { infoByToken } from '../services/invitations'
import { createBookingSchema } from '../../../src/core/schema'
import { referencesUpload, sniffImageMime } from '../middleware/upload'

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
        // строгая гражданская дата: отсекает и «9999-99-99», и «2026-02-30»
        dateFrom: z.string().refine(isValidCivilDate, 'Некорректная дата'),
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
    const requestedService = bundle.services.find((s) => s.id === body.serviceId)
    if (!requestedService) {
      res.json({ slots: [], reason: 'Услуга не найдена' })
      return
    }
    if (offsiteRequiredFor(requestedService)) {
      const zone = bundle.settings.travelZones.find((z) => z.id === body.travelZoneId)
      if (!body.offsite || !zone) {
        res.json({ slots: [], reason: 'Выберите зону выезда — услуга проводится только на выезде' })
        return
      }
    }
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
  // П9: ключ IP+slug — офисный NAT не съедает лимит чужой студии
  rateLimit('book', 10, 60, (req) => `:${req.params.slug}`),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    const bundle = await loadStudioBundle(studio.id, studio.slug)
    const parsed = createBookingSchema.parse({ ...req.body, slug: req.params.slug })
    const { slug: _slug, ...payload } = parsed
    // повторяющиеся id допа умножали его строку в цене
    if (payload.addonIds) payload.addonIds = [...new Set(payload.addonIds)]
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
    // аренда всегда занимает зал; съёмка — только если админ включил «нужен зал»
    const needHall = service.needsHall || service.kind === 'rental'
    const zone = bundle.settings.travelZones.find((z) => z.id === payload.travelZoneId)
    // Специалист без зала — только выезд; выбранная зона должна существовать.
    if (offsiteRequiredFor(service) && (!payload.offsite || !zone)) {
      throw badRequest('Для этой услуги со специалистом выберите зону выезда')
    }
    if (payload.offsite && !zone) {
      throw badRequest('Зона выезда не найдена')
    }
    // белый список залов услуги: пусто/undefined — любой активный зал
    const allowedHalls = bundle.halls.filter(
      (h) => h.active && (!service.hallIds?.length || service.hallIds.includes(h.id))
    )
    const hall = needHall ? allowedHalls.find((h) => h.id === payload.hallId) ?? null : null
    if (needHall && payload.hallId && !hall) throw badRequest('Зал недоступен для этой услуги')
    const allowedSpecs = bundle.specialists.filter(
      (s) => s.active && (!service.specialistIds?.length || service.specialistIds.includes(s.id))
    )
    if (service.needsSpecialist && service.allSpecialistsRequired) {
      if (!service.specialistIds?.length) throw badRequest('В услуге не настроены специалисты')
      if (allowedSpecs.length !== service.specialistIds.length) {
        throw badRequest('Не все специалисты услуги доступны')
      }
    }
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
  rateLimit('avail', 60, 60, (req) => `:${req.params.slug}`),
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

// Y3: загрузка референсов клиентом. Токен брони — секрет: доступ без авторизации
// легитимен (как у /bookings/:token). Лимит того же класса, что у брони (10/мин),
// но со своим счётчиком и ключом slug: общий NAT не расходует лимит чужих студий,
// а загрузка референсов не тратит лимит создания заявки.
publicRouter.post(
  '/studios/:slug/bookings/:token/references',
  rateLimit('book-refs', 10, 60, (req) => `:${req.params.slug}`),
  referencesUpload.array('files', 5),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    const files = req.files as Express.Multer.File[] | undefined
    if (!files || files.length === 0) throw badRequest('Нет файлов')
    // mimetype выбирает клиент: тип файла проверяем по сигнатуре
    for (const f of files) {
      if (!sniffImageMime(f.buffer)) throw badRequest('Файл не является изображением (jpg/png/webp)')
    }
    const saved = await saveReferenceFiles(studio.id, req.params.token, files)
    if (saved === null) throw notFound('Запись не найдена')
    res.status(201).json({ ok: true, count: saved })
  })
)

// Список референсов брони — для экрана «Моя запись» (по секретному токену)
publicRouter.get(
  '/studios/:slug/bookings/:token/references',
  rateLimit('avail', 60),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    res.json({ items: await listReferences(studio.id, req.params.token, false) })
  })
)

// П1: клиент скачивает свой референс по токену брони (не статикой)
publicRouter.get(
  '/studios/:slug/bookings/:token/references/:refId/file',
  rateLimit('avail', 60),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    const booking = await getBookingByTokenHash(studio.id, studio.slug, req.params.token)
    if (!booking) throw notFound('Запись не найдена')
    const r = await query<{ file_path: string; mime: string }>(
      `select file_path, mime from booking_references
       where id = $1 and booking_id = $2 and studio_id = $3`,
      [req.params.refId, booking.id, studio.id]
    )
    if (r.rows.length === 0) throw notFound('Файл не найден')
    const abs = path.resolve(config.UPLOADS_DIR, r.rows[0].file_path)
    // страховка от path traversal: не выходим за пределы UPLOADS_DIR
    if (!abs.startsWith(path.resolve(config.UPLOADS_DIR) + path.sep)) throw notFound('Файл не найден')
    res.setHeader('Content-Type', r.rows[0].mime)
    res.setHeader('Cache-Control', 'private, max-age=0, no-store')
    res.sendFile(abs)
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
  // токен брони: подписка привязывается к записи клиента, и напоминание
  // приходит только на устройство, где его включали для этой записи
  token: z.string().min(10).max(200),
})

publicRouter.post(
  '/studios/:slug/push-subscribe',
  rateLimit('push', 10, 60, (req) => `:${req.params.slug}`),
  asyncHandler(async (req, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    const body = pushSubscribeSchema.parse(req.body)
    const booking = await getBookingByTokenHash(studio.id, studio.slug, body.token)
    if (!booking) throw notFound('Запись не найдена')
    await savePushSubscription(studio.id, { endpoint: body.endpoint, keys: body.keys }, booking.id)
    res.status(204).end()
  })
)

publicRouter.post(
  '/studios/:slug/push-unsubscribe',
  rateLimit('push', 10, 60, (req) => `:${req.params.slug}`),
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
