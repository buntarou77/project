import { z } from 'npm:zod'
import { json, preflight } from '../_shared/cors.ts'
import { rateLimit } from '../_shared/limits.ts'
import { loadStudioData } from '../_shared/studio.ts'
import { computeAvailability } from '../_shared/core/availability.ts'
import { loadBusy } from '../_shared/busy.ts'

const bodySchema = z.object({
  slug: z.string().min(2),
  serviceId: z.string().min(1),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dayCount: z.number().int().min(1).max(5).optional(),
  durationMin: z.number().int().min(30).max(24 * 60).optional(),
  specialistId: z.string().nullable().optional(),
  hallId: z.string().nullable().optional(),
  offsite: z.boolean().optional(),
  travelZoneId: z.string().nullable().optional(),
  peopleCount: z.number().int().min(1).max(200).optional(),
})

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    const parsed = bodySchema.safeParse(await req.json())
    if (!parsed.success) return json({ error: 'Некорректный запрос', issues: parsed.error.issues }, 400)
    const q = parsed.data

    const ip = req.headers.get('x-forwarded-for') ?? 'anon'
    if (!(await rateLimit(`avail:${q.slug}:${ip}`, 60))) return json({ error: 'Слишком много запросов' }, 429)

    const studio = await loadStudioData(q.slug)
    if (!studio) return json({ error: 'Студия не найдена' }, 404)
    const service = studio.services.find((s) => s.id === q.serviceId)
    if (!service) return json({ error: 'Услуга не найдена' }, 404)

    const zone = studio.settings.travelZones.find((z) => z.id === q.travelZoneId)
    const offsite = Boolean(q.offsite)
    const durationMin = q.durationMin ?? service.durationMin
    const dayCount = service.multiDayMax > 1 ? (q.dayCount ?? 1) : 1

    const { busy, dayLimitBookings, fullDayBusy } = await loadBusy(studio)

    const result = computeAvailability({
      tz: studio.settings.tz,
      schedule: studio.settings.schedule,
      closedDates: studio.settings.closedDates,
      dateFrom: q.dateFrom,
      service,
      specialistId: q.specialistId ?? null,
      hallId: q.hallId ?? null,
      specialists: studio.specialists,
      halls: studio.halls,
      busy,
      dayLimitBookings,
      fullDayBusy,
      offsite,
      travelBeforeMin: offsite ? (zone?.minutesBefore ?? 0) : 0,
      travelAfterMin: offsite ? (zone?.minutesAfter ?? 0) : 0,
      durationMin,
      dayCount,
      peopleCount: q.peopleCount,
      nowMs: Date.now(),
    })

    return json({ slots: result.slots, reason: result.reason })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Ошибка' }, 500)
  }
})
