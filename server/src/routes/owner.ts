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
import { portfolioUpload } from '../middleware/upload'
import type { BookingRecord } from '../../../src/backend/types'
import type { TenantSettings } from '../../../src/core/types'
import { tenantSettingsSchema } from '../../../src/core/schema'
import { userStudios } from '../services/auth'
import {
  anonymizeClient,
  CLOSING_STATUSES,
  insertBookingWithResources,
  listBookings,
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
    const tok = await query(`select calendar_token from studios where id = $1`, [req.studio!.id])
    res.json({ ...bundle, calendarToken: tok.rows[0].calendar_token })
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

const manualSchema = z.object({
  kind: z.enum(['shoot', 'rental']),
  serviceId: z.string(),
  serviceName: z.string().default(''),
  specialistId: z.string().nullable().optional(),
  hallId: z.string().nullable().optional(),
  startsAtMs: z.number().int().positive(),
  endsAtMs: z.number().int().positive(),
  allDay: z.boolean().default(false),
  dayCount: z.number().int().default(1),
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
  paidTotal: z.number().default(0),
  deliverablesUrl: z.string().nullable().optional(),
  offsite: z.boolean().default(false),
  travelZoneId: z.string().nullable().optional(),
  consent: z.any().default({ version: 'manual', atMs: Date.now() }),
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

    const result = await insertBookingWithResources({
      studioId: studio.id,
      slug: studio.slug,
      kind: body.kind,
      serviceId: service?.id ?? null,
      serviceName: body.serviceName || service?.name || '',
      specialistId: body.specialistId ?? null,
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
        paidTotal: z.number().optional(),
        deliverablesUrl: z.string().optional(),
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

// ---------- настройки и каталог ----------

ownerRouter.put(
  '/studios/:slug/settings',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    // Zod на каждом входе; статус студии (demo/active) — не поле владельца:
    // плашка «Образец» и noindex управляются только платформой (§3).
    const settings = tenantSettingsSchema.parse(req.body) as unknown as TenantSettings
    settings.status = req.studio!.status
    await saveSettings(req.studio!.id, settings)
    res.json({ ok: true, settings })
  })
)

ownerRouter.post(
  '/studios/:slug/specialists',
  requireStudioAccess('catalog:write'),
  asyncHandler(async (req: StudioRequest, res) => {
    await upsertSpecialist(req.studio!.id, req.body)
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
    await upsertHall(req.studio!.id, req.body)
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
    await upsertService(req.studio!.id, req.body)
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

// ---------- закрытые периоды (отпуска специалистов, закрытия залов/студии) ----------

const closedPeriodSchema = z.object({
  id: z.string().optional(),
  resourceType: z.enum(['specialist', 'hall', 'studio']),
  resourceId: z.string().nullable().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(200).default(''),
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
    })
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
    await upsertAddon(req.studio!.id, req.body)
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
    await upsertPortfolioItem(req.studio!.id, req.body)
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
