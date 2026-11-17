import type { NextFunction, Request, Response } from 'express'
import { query } from '../db'
import { ApiHttpError, asyncHandler } from './errors'
import type { AuthedRequest } from './auth'

export type StudioPermission = 'bookings:read' | 'bookings:write' | 'finance:read' | 'catalog:write' | 'team:manage'

// Матрица прав — фиксируется в коде, не в БД (§3). Роли admin в memberships нет.
export const ROLE_PERMISSIONS: Record<'owner' | 'manager' | 'employee', StudioPermission[]> = {
  owner: ['bookings:read', 'bookings:write', 'finance:read', 'catalog:write', 'team:manage'],
  manager: ['bookings:read', 'bookings:write', 'finance:read', 'catalog:write'],
  employee: ['bookings:read'],
}

export interface StudioContext {
  id: string
  slug: string
  settings: Record<string, unknown>
  status: 'demo' | 'active'
  role: 'owner' | 'manager' | 'employee'
}

export interface StudioRequest extends AuthedRequest {
  studio?: StudioContext
}

// Замена RLS: находит студию по slug, membership текущего юзера, проверяет право.
export function requireStudioAccess(permission: StudioPermission | null) {
  return asyncHandler(async (req: StudioRequest, _res: Response, next: NextFunction) => {
    const slug = req.params.slug
    if (!slug) throw new ApiHttpError(400, 'VALIDATION', 'Не указан slug студии')
    const studio = await query(
      `select id, slug, settings, status from studios where slug = $1`,
      [slug]
    )
    if (studio.rows.length === 0) throw new ApiHttpError(404, 'NOT_FOUND', 'Студия не найдена')
    const m = await query(`select role from memberships where user_id = $1 and studio_id = $2`, [
      req.userId,
      studio.rows[0].id,
    ])
    if (m.rows.length === 0) throw new ApiHttpError(403, 'FORBIDDEN', 'Нет доступа к этой студии')
    const role = m.rows[0].role as 'owner' | 'manager' | 'employee'
    if (permission && !ROLE_PERMISSIONS[role].includes(permission)) {
      throw new ApiHttpError(403, 'FORBIDDEN', 'Недостаточно прав для этого действия')
    }
    req.studio = {
      id: studio.rows[0].id,
      slug: studio.rows[0].slug,
      settings: studio.rows[0].settings,
      status: studio.rows[0].status,
      role,
    }
    next()
  })
}

// Платформ-админ: флаг на пользователе, не роль в memberships (§3).
export const requirePlatformAdmin = asyncHandler(async (req: AuthedRequest, _res: Response, next: NextFunction) => {
  const u = await query(`select is_platform_admin from users where id = $1 and is_active = true`, [req.userId])
  if (u.rows.length === 0 || u.rows[0].is_platform_admin !== true) {
    throw new ApiHttpError(403, 'FORBIDDEN', 'Требуются права администратора платформы')
  }
  next()
})

export function can(studio: StudioContext, permission: StudioPermission): boolean {
  return ROLE_PERMISSIONS[studio.role].includes(permission)
}
