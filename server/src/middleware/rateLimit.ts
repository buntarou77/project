import type { NextFunction, Request, Response } from 'express'
import { query } from '../db'
import { ApiHttpError, asyncHandler } from './errors'

// Атомарный счётчик в БД: increment_rate_limit() из миграции.
// При сбое БД лимитер не должен блокировать API (fail-open, паритет edge-функций).
export async function incrementRateLimit(key: string, windowStart: Date): Promise<number> {
  try {
    const r = await query<{ count: number }>(`select increment_rate_limit($1, $2) as count`, [key, windowStart])
    return r.rows[0].count
  } catch (e) {
    console.error('rate-limit error:', e instanceof Error ? e.message : e)
    return 0
  }
}

function currentWindow(windowSec: number): Date {
  return new Date(Math.floor(Date.now() / (windowSec * 1000)) * windowSec * 1000)
}

export function rateLimit(prefix: string, limit: number, windowSec = 60, keyBy?: (req: Request) => string) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const ip = req.ip ?? 'unknown'
    // П9: дополнительный ключ (например, slug) — общий NAT не должен
    // расходовать лимит разных студий из одного счётчика
    const extra = keyBy ? keyBy(req) : ''
    const count = await incrementRateLimit(`${prefix}:${ip}${extra}`, currentWindow(windowSec))
    if (count > limit) {
      throw new ApiHttpError(429, 'RATE_LIMITED', 'Слишком много запросов, попробуйте позже')
    }
    next()
  })
}

// Лимит логина по связке IP+email (§5.3), чтобы не перебирать пароли одного аккаунта.
export const loginRateLimit = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const ip = req.ip ?? 'unknown'
  const email = String(req.body?.email ?? 'unknown').toLowerCase()
  const count = await incrementRateLimit(`login:${ip}:${email}`, currentWindow(60))
  if (count > 10) {
    throw new ApiHttpError(429, 'RATE_LIMITED', 'Слишком много попыток входа, подождите минуту')
  }
  next()
})
