import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { query } from '../db'
import { config } from '../config'
import { asyncHandler, badRequest, notFound } from '../middleware/errors'
import { requireAuth } from '../middleware/auth'
import { can, requireStudioAccess, type StudioRequest } from '../middleware/studioAccess'
import { portfolioUpload, sniffImageMime } from '../middleware/upload'
import type { BookingRecord } from '../../../src/backend/types'
import type { Addon, Hall, PortfolioItem, Service, Specialist, TenantSettings } from '../../../src/core/types'
import { prepaymentSchema, tenantSettingsSchema, weeklyWindowSchema } from '../../../src/core/schema'
import { offsiteRequiredFor } from '../../../src/core/availability'
import { isValidCivilDate } from '../../../src/core/time'
import { userStudios } from '../services/auth'
import {
  anonymizeClient,
  CLOSING_STATUSES,
  insertBookingWithResources,
  listBookings,
  listReferences,
  updateBooking,
} from '../services/bookings'
import {
  deleteAddon,
  deleteClosedPeriod,
  deleteHall,
  deletePortfolioItem,
  deleteService,
  deleteSpecialist,
  getStudioBySlug,
  listClosedPeriods,
  loadStudioBundle,
  saveSettings,
  upsertAddon,
  upsertClosedPeriod,
  upsertHall,
  upsertPortfolioItem,
  upsertService,
  upsertSpecialist,
} from '../services/catalog'
import { runAssistant } from '../services/assistant'

export const ownerRouter = Router()
ownerRouter.use(requireAuth)

// ---------- студии пользователя ----------

ownerRouter.get(
  '/studios',
  asyncHandler(async (req: StudioRequest, res) => {
    res.json({ items: await userStudios(req.userId!) })
  })
)

ownerRouter.get(
  '/studios/:slug',
  requireStudioAccess(null),
  asyncHandler(async (req: StudioRequest, res) => {
    const bundle = await loadStudioBundle(req.studio!.id, req.studio!.slug)
    // B1: календарный токен — это read-лента всех броней; только finance:read
    const tok = can(req.studio!, 'finance:read')
      ? await query(`select calendar_token from studios where id = $1`, [req.studio!.id])
      : null
    res.json({ ...bundle, calendarToken: tok?.rows[0]?.calendar_token ?? null })
  })
)

// ---------- заявки ----------

ownerRouter.get(
  '/studios/:slug/bookings',
  requireStudioAccess('bookings:read'),
  asyncHandler(async (req: StudioRequest, res) => {
    const q = req.query as Record<string, string | undefined>
    const result = await listBookings(req.studio!.id, req.studio!.slug, {
      status: q.status,
      specialistId: q.specialistId || undefined,
      hallId: q.hallId || undefined,
      dateFrom: q.dateFrom || undefined,
      dateTo: q.dateTo || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      cursor: q.cursor ? Number(q.cursor) : undefined,
      tz: req.studio!.settings.tz as string,
    })
    // finance:read: сотрудник не видит суммы вообще (§3)
    const items = can(req.studio!, 'finance:read')
      ? result.items
      : result.items.map((b) => ({
          ...b,
          paidTotal: 0,
          price: { lines: [], total: 0, prepayment: 0 },
        }))
    res.json({ items, nextCursor: result.nextCursor })
  })
)

// B2: каталог — валидация на входе (как у settings), не «что прислали, то и в БД»
const specialistSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  title: z.string().max(200).default(''),
  active: z.boolean().default(true),
  dayLimit: z.number().int().min(1).max(10).default(1),
  photoUrl: z.string().max(2048).nullable().optional(),
  showOnTeam: z.boolean().default(true),
  schedule: z.record(weeklyWindowSchema).nullable().optional(),
  hourRate: z.number().int().min(0).max(100000).nullable().optional(),
})

const hallSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  capacity: z.number().int().min(1).max(1000),
  rates: z.object({
    weekday: z.object({ day: z.number().int().min(0), evening: z.number().int().min(0) }),
    weekend: z.object({ day: z.number().int().min(0), evening: z.number().int().min(0) }),
  }),
  active: z.boolean().default(true),
  photos: z.array(z.string().max(2048)).max(12).default([]),
})

const serviceSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['shoot', 'rental']),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).default(''),
  priceType: z.enum(['fixed', 'hourly']),
  price: z.number().int().min(0).max(10_000_000),
  durationMin: z.number().int().min(15).max(24 * 60),
  includes: z.array(z.string().max(200)).max(30).default([]),
  deliverableText: z.string().max(200).default(''),
  deadlineDays: z.number().int().min(0).max(365).default(7),
  prepayment: prepaymentSchema,
  needsSpecialist: z.boolean().default(false),
  needsHall: z.boolean().default(false),
  defaultHallId: z.string().max(64).nullable().optional(),
  hallIds: z.array(z.string().max(64)).max(50).nullable().optional(),
  specialistIds: z.array(z.string().max(64)).max(50).nullable().optional(),
  addonIds: z.array(z.string().max(64)).max(50).nullable().optional(),
  photoUrl: z.string().max(2048).nullable().optional(),
  maxPeople: z.number().int().min(1).max(1000).nullable().optional(),
  fullDay: z.boolean().default(false),
  multiDayMax: z.number().int().min(1).max(5).default(1),
  autoConfirm: z.boolean().default(false),
  setupMin: z.number().int().min(0).max(240).default(0),
  cleanupMin: z.number().int().min(0).max(240).default(0),
  sort: z.number().int().min(0).max(9999).default(0),
  referencesEnabled: z.boolean().nullable().optional(),
  allSpecialistsRequired: z.boolean().default(false),
})

const addonSchema = z.object({
  id: z.string().min(1).max(64),
  appliesTo: z.enum(['shoot', 'rental', 'both']),
  name: z.string().min(1).max(160),
  price: z.number().int().min(0).max(1_000_000),
  unit: z.enum(['booking', 'hour', 'person']),
  hallIds: z.array(z.string().max(64)).max(50).nullable().optional(),
})

const portfolioItemSchema = z.object({
  id: z.string().min(1).max(64),
  category: z.string().min(1).max(60),
  caption: z.string().max(300).default(''),
  kind: z.enum(['image', 'video']).default('image'),
  videoUrl: z.string().max(2048).nullable().optional(),
  src: z.string().min(1).max(2048),
  srcset: z.string().max(4096).nullable().optional(),
  sort: z.number().int().min(0).max(9999).default(0),
})

const manualSchema = z.object({
  kind: z.enum(['shoot', 'rental']),
  serviceId: z.string(),
  serviceName: z.string().default(''),
  specialistId: z.string().nullable().optional(),
  hallId: z.string().nullable().optional(),
  startsAtMs: z.number().int().positive(),
  endsAtMs: z.number().int().positive(),
  allDay: z.boolean().default(false),
  dayCount: z.number().int().min(1).max(5).default(1),
  status: z
    .enum(['new', 'confirmed', 'prepaid', 'shot_done', 'processing', 'delivered', 'completed', 'cancelled_by_client', 'rejected', 'no_show'])
    .default('confirmed'),
  client: z.object({
    name: z.string().min(1),
    phone: z.string().default('—'),
    method: z.string().default('phone'),
    people: z.number().optional(),
    notes: z.string().optional(),
    referenceCount: z.number().optional(),
  }),
  price: z
    .object({
      lines: z.array(z.any()).default([]),
      total: z.number().default(0),
      prepayment: z.number().default(0),
    })
    .default({ lines: [], total: 0, prepayment: 0 }),
  paidTotal: z.number().int().min(0).max(100_000_000).default(0),
  deliverablesUrl: z
    .string()
    .url()
    .max(2048)
    .refine((v) => /^https?:\/\//.test(v), 'Только http(s)-ссылки')
    .nullable()
    .optional(),
  offsite: z.boolean().default(false),
  travelZoneId: z.string().nullable().optional(),
  consent: z.any().default({ version: 'manual', atMs: Date.now() }),
}).refine((v) => v.endsAtMs > v.startsAtMs, {
  message: 'Конец брони должен быть позже начала',
})

// Ручная заявка «из мессенджера/звонка»; §8.3: блокировки создаются той же транзакцией.
ownerRouter.post(
  '/studios/:slug/bookings',
  requireStudioAccess('bookings:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    const body = manualSchema.parse(req.body)
    const studio = req.studio!
    const bundle = await loadStudioBundle(studio.id, studio.slug)
    const service = bundle.services.find((s) => s.id === body.serviceId) ?? null

    // B-09: чужой или неактивный зал/специалист — 400, а не 500 от внешнего ключа
    if (body.hallId && !bundle.halls.some((h) => h.id === body.hallId && h.active)) {
      throw badRequest('Зал не найден')
    }
    if (body.specialistId && !bundle.specialists.some((sp) => sp.id === body.specialistId && sp.active)) {
      throw badRequest('Специалист не найден')
    }
    if (service && !service.needsSpecialist && body.specialistId) {
      throw badRequest('Эта услуга не требует специалиста')
    }

    // Ручная заявка не должна обходить белый список залов услуги: селект в
    // кабинете фильтруется на фронте, но API — отдельный вход.
    if (service) {
      const needHall = service.needsHall || service.kind === 'rental'
      const allowedHalls = bundle.halls.filter(
        (h) => h.active && (!service.hallIds?.length || service.hallIds.includes(h.id))
      )
      if (needHall && !body.hallId) throw badRequest('Для этой услуги нужен зал')
      if (needHall && body.hallId && !allowedHalls.some((h) => h.id === body.hallId)) {
        throw badRequest('Зал недоступен для этой услуги')
      }
      const zone = bundle.settings.travelZones.find((z) => z.id === body.travelZoneId)
      if (offsiteRequiredFor(service) && (!body.offsite || !zone)) {
        throw badRequest('Для этой услуги со специалистом выберите зону выезда')
      }
      if (body.offsite && !zone) {
        throw badRequest('Зона выезда не найдена')
      }
    }

    // Команда услуги: админ уже выбрал состав, ручная заявка блокирует всех.
    let specialistIds = body.specialistId ? [body.specialistId] : []
    let specialistId = body.specialistId ?? null
    if (service?.needsSpecialist && service.allSpecialistsRequired) {
      const teamIds = service.specialistIds ?? []
      const team = teamIds
        .map((id) => bundle.specialists.find((s) => s.id === id && s.active) ?? null)
        .filter((s): s is NonNullable<typeof s> => Boolean(s))
      if (!teamIds.length) throw badRequest('В услуге не настроены специалисты')
      if (team.length !== teamIds.length) throw badRequest('Не все специалисты услуги доступны')
      specialistIds = team.map((s) => s.id)
      specialistId = specialistIds[0]
    }

    const result = await insertBookingWithResources({
      studioId: studio.id,
      slug: studio.slug,
      kind: body.kind,
      serviceId: service?.id ?? null,
      serviceName: body.serviceName || service?.name || '',
      specialistId,
      specialistIds,
      hallId: body.hallId ?? null,
      startsAtMs: body.startsAtMs,
      endsAtMs: body.endsAtMs,
      allDay: body.allDay,
      dayCount: body.dayCount,
      status: body.status,
      client: body.client,
      // цена с клиента принимается только для ручных заявок (§7.2)
      price: body.price,
      source: 'manual',
      offsite: body.offsite,
      travelZoneId: body.travelZoneId ?? null,
      consent: body.consent,
      idempotencyKey: `manual-${randomUUID()}`,
      paidTotal: body.paidTotal,
      // заявка, созданная сразу закрывающим статусом (вкл. completed), время не блокирует
      block: !CLOSING_STATUSES.includes(body.status),
      settings: bundle.settings,
      service: service ? { setupMin: service.setupMin, cleanupMin: service.cleanupMin, fullDay: service.fullDay } : null,
    })
    if (result.duplicate) throw badRequest('Не удалось создать заявку')
    let withPaid: BookingRecord = result.record
    if (body.paidTotal !== 0) withPaid = { ...withPaid, paidTotal: body.paidTotal }
    if (body.deliverablesUrl) {
      await query(`update bookings set deliverables_url = $2 where id = $1 and studio_id = $3`, [
        result.record.id,
        body.deliverablesUrl,
        studio.id,
      ])
    }
    res.status(201).json(withPaid)
  })
)

ownerRouter.patch(
  '/studios/:slug/bookings/:id',
  requireStudioAccess('bookings:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    const patch = z
      .object({
        status: z
          .enum(['new', 'confirmed', 'prepaid', 'shot_done', 'processing', 'delivered', 'completed', 'cancelled_by_client', 'rejected', 'no_show'])
          .optional(),
        paidTotal: z.number().int().min(0).max(100_000_000).optional(),
        deliverablesUrl: z
          .string()
          .url()
          .max(2048)
          .refine((v) => /^https?:\/\//.test(v), 'Только http(s)-ссылки')
          .optional(),
        startsAtMs: z.number().int().optional(),
        endsAtMs: z.number().int().optional(),
      })
      .parse(req.body)
    const bundle = await loadStudioBundle(req.studio!.id, req.studio!.slug)
    const booking = await updateBooking(
      { id: req.studio!.id, slug: req.studio!.slug, settings: bundle.settings },
      req.params.id,
      patch
    )
    res.json({
      ok: true,
      // finance:read: сотрудник не видит суммы вообще (§3)
      booking: can(req.studio!, 'finance:read')
        ? booking
        : { ...booking, paidTotal: 0, price: { lines: [], total: 0, prepayment: 0 } },
    })
  })
)

ownerRouter.post(
  '/studios/:slug/bookings/:id/anonymize',
  requireStudioAccess('bookings:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    await anonymizeClient(req.studio!.id, req.params.id)
    res.json({ ok: true })
  })
)

// Y3: референсы брони — персональные файлы: только владельцу и менеджеру
// (bookings:write); сотрудник с «только чтение» их не видит, как и обещает политика
ownerRouter.get(
  '/studios/:slug/bookings/:id/references',
  requireStudioAccess('bookings:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    res.json({ items: await listReferences(req.studio!.id, req.params.id, true) })
  })
)

// П1: файл референса отдаётся только с доступом к студии (не статикой)
ownerRouter.get(
  '/studios/:slug/bookings/:id/references/:refId/file',
  requireStudioAccess('bookings:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    const r = await query<{ file_path: string; mime: string }>(
      `select file_path, mime from booking_references
       where id = $1 and booking_id = $2 and studio_id = $3`,
      [req.params.refId, req.params.id, req.studio!.id]
    )
    if (r.rows.length === 0) throw notFound('Файл не найден')
    const abs = path.resolve(config.UPLOADS_DIR, r.rows[0].file_path)
    // страховка от path traversal: не выходим за пределы UPLOADS_DIR
    if (!abs.startsWith(path.resolve(config.UPLOADS_DIR) + path.sep)) throw notFound('Файл не найден')
    res.setHeader('Content-Type', r.rows[0].mime)
    res.setHeader('Cache-Control', 'private, max-age=0, no-store') // персональные данные не кэшируем
    res.sendFile(abs)
  })
)

// ---------- настройки и каталог ----------

ownerRouter.put(
  '/studios/:slug/settings',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    // Zod на каждом входе; статус студии (demo/active) — не поле владельца:
    // плашка «Образец» и noindex управляются только платформой (§3).
    const settings = tenantSettingsSchema.parse(req.body) as unknown as TenantSettings
    // B4: slug и status — не поля владельца: slug задаёт платформа (по нему
    // строятся все ссылки витрины), status тоже. Перетираем вход.
    settings.slug = req.studio!.slug
    settings.status = req.studio!.status
    await saveSettings(req.studio!.id, settings)
    res.json({ ok: true, settings })
  })
)

ownerRouter.post(
  '/studios/:slug/specialists',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    const item = specialistSchema.parse(req.body) as Specialist
    await upsertSpecialist(req.studio!.id, item)
    res.status(204).end()
  })
)

ownerRouter.delete(
  '/studios/:slug/specialists/:id',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    await deleteSpecialist(req.studio!.id, req.params.id)
    res.status(204).end()
  })
)

// Фото специалиста: клиент сжимает (§8), сервер валидирует и кладёт в uploads.
ownerRouter.post(
  '/studios/:slug/specialists/upload',
  requireStudioAccess('catalog:write'),
  portfolioUpload.single('file'),
  asyncHandler(async (req: StudioRequest, res) => {
    const f = req.file
    if (!f) throw badRequest('Нет файла')
    const uuid = randomUUID()
    const dir = path.join(config.UPLOADS_DIR, req.studio!.id, 'specialists')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${uuid}.jpg`), f.buffer)
    res.json({ src: `${config.PUBLIC_BASE_URL}/uploads/${req.studio!.id}/specialists/${uuid}.jpg` })
  })
)

// Фото зала: клиент сжимает (§8), сервер валидирует и кладёт в uploads.
ownerRouter.post(
  '/studios/:slug/halls/upload',
  requireStudioAccess('catalog:write'),
  portfolioUpload.single('file'),
  asyncHandler(async (req: StudioRequest, res) => {
    const f = req.file
    if (!f) throw badRequest('Нет файла')
    const uuid = randomUUID()
    const dir = path.join(config.UPLOADS_DIR, req.studio!.id, 'halls')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${uuid}.jpg`), f.buffer)
    res.json({ src: `${config.PUBLIC_BASE_URL}/uploads/${req.studio!.id}/halls/${uuid}.jpg` })
  })
)

ownerRouter.post(
  '/studios/:slug/halls',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    const item = hallSchema.parse(req.body) as Hall
    await upsertHall(req.studio!.id, item)
    res.status(204).end()
  })
)

ownerRouter.delete(
  '/studios/:slug/halls/:id',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    await deleteHall(req.studio!.id, req.params.id)
    res.status(204).end()
  })
)

ownerRouter.post(
  '/studios/:slug/services',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    const item = serviceSchema.parse(req.body) as Service
    // B2: белые списки услуги не должны ссылаться на чужие/несуществующие id
    const bundle = await loadStudioBundle(req.studio!.id, req.studio!.slug)
    const badHalls = (item.hallIds ?? []).filter((id) => !bundle.halls.some((h) => h.id === id))
    if (badHalls.length) throw badRequest(`Залы не найдены: ${badHalls.join(', ')}`)
    const badSpecs = (item.specialistIds ?? []).filter((id) => !bundle.specialists.some((s) => s.id === id))
    if (badSpecs.length) throw badRequest(`Специалисты не найдены: ${badSpecs.join(', ')}`)
    const badAddons = (item.addonIds ?? []).filter((id) => !bundle.addons.some((a) => a.id === id))
    if (badAddons.length) throw badRequest(`Допуслуги не найдены: ${badAddons.join(', ')}`)
    if (item.defaultHallId && !bundle.halls.some((h) => h.id === item.defaultHallId)) {
      throw badRequest('defaultHallId: зал не найден')
    }
    if (item.allSpecialistsRequired && !(item.specialistIds ?? []).length) {
      throw badRequest('Услуга-команда требует хотя бы одного специалиста')
    }
    // Y4 (P3): услуга-команда не должна молча остаться без исполнителей,
    // если всех её специалистов выключили/удалили из состава.
    const activeSpecIds = new Set(bundle.specialists.filter((s) => s.active).map((s) => s.id))
    if (item.allSpecialistsRequired && (item.specialistIds ?? []).some((id) => !activeSpecIds.has(id))) {
      throw badRequest('Услуга-команда содержит неактивных специалистов — включите их или уберите из состава')
    }
    await upsertService(req.studio!.id, item)
    res.status(204).end()
  })
)

// Обложка услуги (клиент сжимает, сервер валидирует и кладёт в uploads).
ownerRouter.post(
  '/studios/:slug/services/upload',
  requireStudioAccess('catalog:write'),
  portfolioUpload.single('file'),
  asyncHandler(async (req: StudioRequest, res) => {
    const f = req.file
    if (!f) throw badRequest('Нет файла')
    const uuid = randomUUID()
    const dir = path.join(config.UPLOADS_DIR, req.studio!.id, 'services')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${uuid}.jpg`), f.buffer)
    res.json({ src: `${config.PUBLIC_BASE_URL}/uploads/${req.studio!.id}/services/${uuid}.jpg` })
  })
)

// Своё фото фона шапки (не из портфолио): клиент сжимает (§8), сервер
// проверяет содержимое по сигнатуре и кладёт в uploads/<studio>/hero. Файл
// публичный, как портфолио. Имя генерирует сервер — имя клиента не
// используется, path traversal исключён. URL владелец сохраняет сам через
// PUT /settings (settings.heroPhotoUrl); заменённый файл стирает saveSettings.
ownerRouter.post(
  '/studios/:slug/hero/upload',
  requireStudioAccess('catalog:write'),
  portfolioUpload.single('file'),
  asyncHandler(async (req: StudioRequest, res) => {
    const f = req.file
    if (!f) throw badRequest('Нет файла')
    const mime = sniffImageMime(f.buffer)
    if (!mime) throw badRequest('Файл не является изображением (jpg/png/webp)')
    const root = path.resolve(config.UPLOADS_DIR)
    const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg'
    const name = `${randomUUID()}${ext}`
    // страховка от path traversal: файл обязан остаться внутри UPLOADS_DIR
    const abs = path.resolve(root, req.studio!.id, 'hero', name)
    if (!abs.startsWith(root + path.sep)) throw badRequest('Некорректный путь файла')
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, f.buffer)
    res.json({ src: `${config.PUBLIC_BASE_URL}/uploads/${req.studio!.id}/hero/${name}` })
  })
)

// ---------- закрытые периоды (отпуска специалистов, закрытия залов/студии) ----------

const closedPeriodSchema = z.object({
  id: z.string().optional(),
  resourceType: z.enum(['specialist', 'hall', 'studio']),
  resourceId: z.string().nullable().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidCivilDate, 'Некорректная дата'),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidCivilDate, 'Некорректная дата'),
  reason: z.string().max(200).default(''),
}).refine((v) => v.dateTo >= v.dateFrom, {
  message: 'Дата «по» не может быть раньше даты «с»',
})

ownerRouter.get(
  '/studios/:slug/closed-periods',
  requireStudioAccess('bookings:read'),
  asyncHandler(async (req: StudioRequest, res) => {
    res.json({ items: await listClosedPeriods(req.studio!.id) })
  })
)

ownerRouter.post(
  '/studios/:slug/closed-periods',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    const body = closedPeriodSchema.parse(req.body)
    const created = await upsertClosedPeriod(req.studio!.id, {
      id: body.id,
      resourceType: body.resourceType,
      resourceId: body.resourceId ?? null,
      dateFrom: body.dateFrom,
      dateTo: body.dateTo,
      reason: body.reason,
    }, req.studio!.settings.tz as string)
    res.status(201).json(created)
  })
)

ownerRouter.delete(
  '/studios/:slug/closed-periods/:id',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    await deleteClosedPeriod(req.studio!.id, req.params.id)
    res.status(204).end()
  })
)

ownerRouter.delete(
  '/studios/:slug/services/:id',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    await deleteService(req.studio!.id, req.params.id)
    res.status(204).end()
  })
)

ownerRouter.post(
  '/studios/:slug/addons',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    const item = addonSchema.parse(req.body) as Addon
    const bundle = await loadStudioBundle(req.studio!.id, req.studio!.slug)
    const badHalls = (item.hallIds ?? []).filter((id) => !bundle.halls.some((h) => h.id === id))
    if (badHalls.length) throw badRequest(`Залы не найдены: ${badHalls.join(', ')}`)
    await upsertAddon(req.studio!.id, item)
    res.status(204).end()
  })
)

ownerRouter.delete(
  '/studios/:slug/addons/:id',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    await deleteAddon(req.studio!.id, req.params.id)
    res.status(204).end()
  })
)

// ---------- портфолио ----------

ownerRouter.post(
  '/studios/:slug/portfolio',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    const item = portfolioItemSchema.parse(req.body) as PortfolioItem
    await upsertPortfolioItem(req.studio!.id, item)
    res.status(204).end()
  })
)

ownerRouter.delete(
  '/studios/:slug/portfolio/:id',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    await deletePortfolioItem(req.studio!.id, req.params.id)
    res.status(204).end()
  })
)

// multipart: file640 (обязательно), file1024, file1600 — результат клиентского сжатия (§8)
ownerRouter.post(
  '/studios/:slug/portfolio/upload',
  requireStudioAccess('catalog:write'),
  portfolioUpload.fields([
    { name: 'file640', maxCount: 1 },
    { name: 'file1024', maxCount: 1 },
    { name: 'file1600', maxCount: 1 },
  ]),
  asyncHandler(async (req: StudioRequest, res) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined
    const base = files?.file640?.[0]
    if (!base) throw badRequest('Обязательно поле file640')
    const uuid = randomUUID()
    const dir = path.join(config.UPLOADS_DIR, req.studio!.id, 'portfolio')
    mkdirSync(dir, { recursive: true })
    const widths: [string, Express.Multer.File][] = [
      ['640', base],
      ['1024', files?.file1024?.[0]],
      ['1600', files?.file1600?.[0]],
    ].filter((x): x is [string, Express.Multer.File] => Boolean(x[1]))
    for (const [w, f] of widths) {
      writeFileSync(path.join(dir, `${uuid}-${w}.jpg`), f.buffer)
    }
    const url = (w: string) => `${config.PUBLIC_BASE_URL}/uploads/${req.studio!.id}/portfolio/${uuid}-${w}.jpg`
    const srcset = widths
      .filter(([w]) => w !== '640')
      .map(([w]) => `${url(w)} ${w}w`)
      .join(', ')
    res.json({ src: url('640'), srcset: srcset || undefined })
  })
)

// ---------- прочее ----------

// Календарная лента раскрывает все брони — только ролям с finance:read
ownerRouter.get(
  '/studios/:slug/calendar-token',
  requireStudioAccess('finance:read'),
  asyncHandler(async (req: StudioRequest, res) => {
    const studio = await getStudioBySlug(req.params.slug)
    if (!studio) throw notFound('Студия не найдена')
    res.json({
      token: studio.calendarToken,
      url: `${config.PUBLIC_BASE_URL}/api/ical/${studio.slug}?token=${encodeURIComponent(studio.calendarToken)}`,
    })
  })
)

// Ассистент жжёт бюджет ИИ — только ролям с finance:read
ownerRouter.post(
  '/studios/:slug/assistant',
  requireStudioAccess('finance:read'),
  asyncHandler(async (req: StudioRequest, res) => {
    const { message } = z.object({ message: z.string().min(1).max(1000) }).parse(req.body)
    const bundle = await loadStudioBundle(req.studio!.id, req.studio!.slug)
    const result = await runAssistant({
      studio: {
        id: req.studio!.id,
        slug: req.studio!.slug,
        settings: bundle.settings,
        specialists: bundle.specialists,
        halls: bundle.halls,
        services: bundle.services,
        addons: bundle.addons,
      },
      message,
      kind: 'owner',
      userId: req.userId,
    })
    res.json(result)
  })
)
