import { Router } from 'express'
import { z } from 'zod'
import { config } from '../config'
import { asyncHandler } from '../middleware/errors'
import { requireAuth, clearAuthCookies, REFRESH_COOKIE } from '../middleware/auth'
import { loginRateLimit, rateLimit } from '../middleware/rateLimit'
import * as auth from '../services/auth'
import type { AuthedRequest } from '../middleware/auth'

export const authRouter = Router()

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

authRouter.post(
  '/login',
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const { email, password } = credentials.parse(req.body)
    const result = await auth.login(email, password, res, req.headers['user-agent'], req.ip)
    res.json(result)
  })
)

// §5.3: активация приглашения новым пользователем; 409 USER_EXISTS → фронт ведёт на вход.
authRouter.post(
  '/register',
  rateLimit('register', 10),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        token: z.string().min(10),
        password: z.string().min(8, 'Пароль минимум 8 символов'),
        email: z.string().email().optional(),
      })
      .parse(req.body)
    const result = await auth.registerViaInvitation(
      body.token,
      body.password,
      body.email,
      res,
      req.headers['user-agent'],
      req.ip
    )
    res.json(result)
  })
)

// Для уже существующего аккаунта (фронт сохраняет токен в sessionStorage).
authRouter.post(
  '/invitations/accept',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body)
    await auth.acceptInvitationForExistingUser(token, req.userId!)
    res.json({ ok: true, studios: await auth.userStudios(req.userId!) })
  })
)

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const ok = await auth.rotateRefresh(req.cookies?.[REFRESH_COOKIE], res, req.headers['user-agent'], req.ip)
    if (!ok) {
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Сессия истекла' } })
      return
    }
    res.status(204).end()
  })
)

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await auth.logout(req.cookies?.[REFRESH_COOKIE], res)
    res.status(204).end()
  })
)

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const u = await auth.userStudios(req.userId!)
    res.json({ authenticated: true, user: { id: req.userId }, studios: u })
  })
)

authRouter.post(
  '/forgot-password',
  rateLimit('forgot', 10),
  asyncHandler(async (req, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body)
    await auth.forgotPassword(email, config.WEB_ORIGIN)
    res.json({ ok: true })
  })
)

authRouter.post(
  '/reset-password',
  rateLimit('reset', 10),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ token: z.string().min(10), password: z.string().min(8, 'Пароль минимум 8 символов') })
      .parse(req.body)
    await auth.resetPassword(body.token, body.password)
    res.json({ ok: true })
  })
)
