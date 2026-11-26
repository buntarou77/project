import { Router } from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/errors'
import { requireAuth } from '../middleware/auth'
import { requireStudioAccess, type StudioRequest } from '../middleware/studioAccess'
import * as invitations from '../services/invitations'
import * as team from '../services/team'

// §7.3: раздел команды — только owner (team:manage).
export const teamRouter = Router()
teamRouter.use(requireAuth)

teamRouter.get(
  '/studios/:slug/team',
  requireStudioAccess('team:manage'),
  asyncHandler(async (req: StudioRequest, res) => {
    const [members, invitationList] = await Promise.all([
      team.listMembers(req.studio!.id),
      invitations.listForStudio(req.studio!.id),
    ])
    res.json({ members, invitations: invitationList })
  })
)

teamRouter.post(
  '/studios/:slug/invitations',
  requireStudioAccess('team:manage'),
  asyncHandler(async (req: StudioRequest, res) => {
    const body = z
      .object({
        email: z.string().email(),
        role: z.enum(['manager', 'employee']),
      })
      .parse(req.body)
    const created = await invitations.createInvitation({
      studioId: req.studio!.id,
      email: body.email,
      role: body.role,
    })
    // ссылка возвращается сразу: без SMTP письмо не уходит, и это единственный
    // способ передать приглашение
    res.status(201).json({ id: created.id, email: created.email, role: created.role, expiresAt: created.expiresAt, url: created.url })
  })
)

teamRouter.delete(
  '/studios/:slug/invitations/:id',
  requireStudioAccess('team:manage'),
  asyncHandler(async (req: StudioRequest, res) => {
    const ok = await invitations.revokeInvitation(req.studio!.id, req.params.id)
    if (!ok) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Приглашение не найдено' } })
      return
    }
    res.status(204).end()
  })
)

teamRouter.patch(
  '/studios/:slug/members/:userId',
  requireStudioAccess('team:manage'),
  asyncHandler(async (req: StudioRequest, res) => {
    const { role } = z.object({ role: z.enum(['owner', 'manager', 'employee']) }).parse(req.body)
    await team.changeRole(req.studio!.id, req.params.userId, role, req.userId!)
    res.json({ ok: true })
  })
)

teamRouter.delete(
  '/studios/:slug/members/:userId',
  requireStudioAccess('team:manage'),
  asyncHandler(async (req: StudioRequest, res) => {
    await team.removeMember(req.studio!.id, req.params.userId, req.userId!)
    res.status(204).end()
  })
)

