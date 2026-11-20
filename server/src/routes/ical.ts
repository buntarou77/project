import { Router } from 'express'
import { asyncHandler, notFound } from '../middleware/errors'
import { rateLimit } from '../middleware/rateLimit'
import { icsForToken } from '../services/ical'

export const icalRouter = Router()

// GET /api/ical/:slug?token=calendar_token | access_token заявки
icalRouter.get(
  '/:slug',
  rateLimit('ical', 60),
  asyncHandler(async (req, res) => {
    const body = await icsForToken(req.params.slug, String(req.query.token ?? ''))
    if (!body) throw notFound('Не найдено')
    res.type('text/calendar').send(body)
  })
)
