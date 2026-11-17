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

// JWT проверяется по подписи без обращения к БД (refresh — отдельный роут).
export const requireAuth = asyncHandler(async (req: AuthedRequest, _res: Response, next: NextFunction) => {
  const token = req.cookies?.[ACCESS_COOKIE] as string | undefined
  if (!token) throw new ApiHttpError(401, 'AUTH_REQUIRED', 'Требуется вход')
  try {
    const payload = verifyAccess(token)
    req.userId = payload.sub
    next()
  } catch {
    throw new ApiHttpError(401, 'AUTH_REQUIRED', 'Сессия истекла')
  }
})

export const hashToken = sha256Hex
