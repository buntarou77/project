import { query } from '../db'
import { sha256Hex, verifyAccess } from '../services/tokens'
import { ApiHttpError, asyncHandler } from './errors'
import type { NextFunction, Request, Response } from 'express'

export const ACCESS_COOKIE = 'pf_access'
export const REFRESH_COOKIE = 'pf_refresh'
const isProd = process.env.NODE_ENV === 'production'

export function setAuthCookies(res: Response, accessJwt: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE, accessJwt, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 15 * 60 * 1000,
  })
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: 30 * 24 * 3600 * 1000,
  })
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE)
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
}

export interface AuthedRequest extends Request {
  userId?: string
}

// JWT проверяется по подписи, но после сброса пароля access-токены должны
// гаснуть немедленно, а не ждать 15 минут — сверяем iat с access_revoked_at
// одним PK-lookup. tokens.ts не трогаем: iat jwt.sign кладёт сам.
export const requireAuth = asyncHandler(async (req: AuthedRequest, _res: Response, next: NextFunction) => {
  const token = req.cookies?.[ACCESS_COOKIE] as string | undefined
  if (!token) throw new ApiHttpError(401, 'AUTH_REQUIRED', 'Требуется вход')
  let payload: { sub: string; iat?: number }
  try {
    payload = verifyAccess(token) as { sub: string; iat?: number }
  } catch {
    throw new ApiHttpError(401, 'AUTH_REQUIRED', 'Сессия истекла')
  }
  const u = await query<{ access_revoked_at: Date | null }>(
    `select access_revoked_at from users where id = $1`,
    [payload.sub]
  )
  if (u.rows.length === 0) throw new ApiHttpError(401, 'AUTH_REQUIRED', 'Требуется вход')
  const revokedAt = u.rows[0].access_revoked_at
  if (revokedAt && (payload.iat ?? 0) * 1000 < new Date(revokedAt).getTime()) {
    throw new ApiHttpError(401, 'AUTH_REQUIRED', 'Сессия отозвана')
  }
  req.userId = payload.sub
  next()
})

export const hashToken = sha256Hex
