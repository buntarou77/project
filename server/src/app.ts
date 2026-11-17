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

// Сборка приложения без прослушивания порта — так его использует и index.ts,
// и интеграционные тесты (supertest).
export function buildApp(): express.Express {
  mkdirSync(config.UPLOADS_DIR, { recursive: true })

  const app = express()
  app.set('trust proxy', 1)

  // CORS: allowlist только origin фронтенда, credentials для cookies (§5.2)
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin === config.WEB_ORIGIN) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
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

  // файлы портфолио: отдаются статикой по абсолютным URL из PUBLIC_BASE_URL
  app.use('/uploads', express.static(path.resolve(config.UPLOADS_DIR)))

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
