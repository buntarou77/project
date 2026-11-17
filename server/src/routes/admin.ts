import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db'
import { asyncHandler, badRequest, notFound } from '../middleware/errors'
import { requireAuth } from '../middleware/auth'
import { requirePlatformAdmin } from '../middleware/studioAccess'
import type { AuthedRequest } from '../middleware/auth'
import * as invitations from '../services/invitations'

// §7.4: slug/status/токены студии меняет только платформ-админ.
export const adminRouter = Router()
adminRouter.use(requireAuth, requirePlatformAdmin)

const settingsShape = z.object({ name: z.string().min(1) }).passthrough()

adminRouter.post(
  '/studios',
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z
      .object({ slug: z.string().regex(/^[a-z0-9-]{2,40}$/), settings: settingsShape, status: z.enum(['demo', 'active']).default('demo') })
      .parse(req.body)
    const exists = await query(`select 1 from studios where slug = $1`, [body.slug])
    if (exists.rows.length > 0) throw badRequest(`Студия с slug «${body.slug}» уже существует`)
    const r = await query(
      `insert into studios (id, slug, settings, status) values ($1, $2, $3, $4) returning id, slug, status`,
      [body.slug, body.slug, JSON.stringify(body.settings), body.status]
    )
    res.status(201).json(r.rows[0])
  })
)

adminRouter.get(
  '/studios',
  asyncHandler(async (_req, res) => {
    const r = await query<{ id: string; slug: string; name: string; status: string }>(
      `select id, slug, settings->>'name' as name, status from studios order by created_at`
    )
    res.json({ items: r.rows })
  })
)

adminRouter.patch(
  '/studios/:slug',
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z
      .object({ status: z.enum(['demo', 'active']).optional(), slug: z.string().regex(/^[a-z0-9-]{2,40}$/).optional() })
      .parse(req.body)
    const cur = await query<{ id: string }>(`select id from studios where slug = $1`, [req.params.slug])
    if (cur.rows.length === 0) throw notFound('Студия не найдена')
    if (body.slug && body.slug !== req.params.slug) {
      const clash = await query(`select 1 from studios where slug = $1`, [body.slug])
      if (clash.rows.length > 0) throw badRequest(`slug «${body.slug}» занят`)
    }
    const r = await query(
      `update studios set
        slug = coalesce($2, slug),
        status = coalesce($3, status),
        updated_at = now()
       where id = $1
       returning id, slug, status`,
      [cur.rows[0].id, body.slug ?? null, body.status ?? null]
    )
    res.json(r.rows[0])
  })
)

adminRouter.post(
  '/studios/:slug/invitations',
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = z
      .object({
        email: z.string().email().nullable().optional(),
        role: z.enum(['owner', 'manager', 'employee']).default('owner'),
      })
      .parse(req.body)
    const studio = await query<{ id: string }>(`select id from studios where slug = $1`, [req.params.slug])
    if (studio.rows.length === 0) throw notFound('Студия не найдена')
    const created = await invitations.createInvitation({
      studioId: studio.rows[0].id,
      email: body.email ?? null,
      role: body.role,
    })
    res.status(201).json(created)
  })
)

adminRouter.get(
  '/studios/:slug/invitations',
  asyncHandler(async (req: AuthedRequest, res) => {
    const studio = await query<{ id: string }>(`select id from studios where slug = $1`, [req.params.slug])
    if (studio.rows.length === 0) throw notFound('Студия не найдена')
    res.json({ items: await invitations.listForStudio(studio.rows[0].id) })
  })
)

adminRouter.delete(
  '/studios/:slug/invitations/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const studio = await query<{ id: string }>(`select id from studios where slug = $1`, [req.params.slug])
    if (studio.rows.length === 0) throw notFound('Студия не найдена')
    const ok = await invitations.revokeInvitation(studio.rows[0].id, req.params.id)
    if (!ok) throw notFound('Приглашение не найдено')
    res.status(204).end()
  })
)
