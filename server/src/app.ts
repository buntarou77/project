import express from 'express'
import cookieParser from 'cookie-parser'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { config } from './config'
import { errorMiddleware } from './middleware/errors'
import { authRouter } from './routes/auth'
import { publicRouter, invitationsRouter } from './routes/public'
import { ownerRouter } from './routes/owner'
import { teamRouter } from './routes/team'
import { adminRouter } from './routes/admin'
import { icalRouter } from './routes/ical'
import { query } from './db'

// Сборка приложения без прослушивания порта — так его использует и index.ts,
// и интеграционные тесты (supertest).
export function buildApp(): express.Express {
  mkdirSync(config.UPLOADS_DIR, { recursive: true })

  const app = express()
  app.set('trust proxy', config.TRUST_PROXY ? 1 : false)

  // Заголовки безопасности (helmet в зависимостях нет — выставляем вручную).
  // HSTS — только когда публичный адрес https: иначе сайт без TLS выпадет на год.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (config.PUBLIC_BASE_URL.startsWith('https://')) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000')
    }
    next()
  })

  // CORS: allowlist только origin фронтенда, credentials для cookies (§5.2)
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin === config.WEB_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Max-Age', '86400') // D7: кэш preflight на сутки
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204)
      return
    }
    next()
  })

  app.use(cookieParser())
  app.use(express.json({ limit: '1mb' }))

  // P6: liveness/readiness для балансировщика
  app.get('/api/health', async (_req, res) => {
    try {
      await query('select 1')
      res.json({ ok: true })
    } catch {
      res.status(503).json({ ok: false })
    }
  })

  // файлы портфолио: отдаются статикой по абсолютным URL из PUBLIC_BASE_URL
  app.use(
    '/uploads',
    // П1: references — персональные данные клиента, статикой не отдаём.
    // Их отдают только авторизованные роуты (owner/public по токену брони).
    (req, res, next) => {
      // Путь декодируем до проверки: serve-static сам раскрывает
      // percent-кодирование, и «re%66erences» иначе уходит мимо запрета
      let decoded = req.path
      try {
        decoded = decodeURIComponent(req.path)
      } catch {
        // битая кодировка — статика сама ответит 400
      }
      if (/\/references\//.test(decoded)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Не найдено' } })
        return
      }
      next()
    },
    express.static(path.resolve(config.UPLOADS_DIR), {
      maxAge: '30d', // D8: имена файлов — uuid, содержимое иммутабельно
      immutable: true,
    })
  )

  app.use('/api/auth', authRouter)
  app.use('/api/public', publicRouter)
  app.use('/api/invitations', invitationsRouter)
  app.use('/api/owner', ownerRouter)
  app.use('/api/owner', teamRouter)
  app.use('/api/admin', adminRouter)
  app.use('/api/ical', icalRouter)

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Не найдено' } })
  })

  app.use(errorMiddleware)
  return app
}
