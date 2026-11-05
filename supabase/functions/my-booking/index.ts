import { z } from 'npm:zod'
import { json, preflight } from '../_shared/cors.ts'
import { rateLimit } from '../_shared/limits.ts'
import { supabaseAdmin } from '../_shared/supabaseAdmin.ts'
import { canCancelByPolicy } from '../_shared/core/availability.ts'

const bodySchema = z.object({
  slug: z.string().min(2),
  token: z.string().uuid(),
  action: z.enum(['get', 'cancel']).optional(),
})

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    const parsed = bodySchema.safeParse(await req.json())
    if (!parsed.success) return json({ error: 'Некорректный запрос' }, 400)
    const { slug, token, action = 'get' } = parsed.data

    if (!(await rateLimit(`my:${token}`, 30))) return json({ error: 'Слишком много запросов' }, 429)

    const sb = supabaseAdmin()
    const { data: booking } = await sb
      .from('bookings')
      .select('*')
      .eq('"accessToken"', token)
      .eq('slug', slug)
      .single()

    if (!booking) return json(null)

    const record = booking as Record<string, unknown>

    if (action === 'cancel') {
      const settingsRes = await sb.from('studios').select('settings').eq('slug', slug).single()
      const settings = (settingsRes.data as { settings: { cancellation: { freeHours: number } } } | null)?.settings
      const can = canCancelByPolicy({
        startsAtMs: new Date(record.startsAt as string).getTime(),
        freeHours: settings?.cancellation.freeHours ?? 48,
        nowMs: Date.now(),
        status: record.status as string,
      })
      if (!can.allowed) return json({ ok: false, error: can.reason }, 400)
      await sb.from('bookings').update({ status: 'cancelled_by_client' }).eq('id', record.id)
      record.status = 'cancelled_by_client'
    }

    // Отдаём запись в доменной форме фронтенда (camelCase)
    return json({
      id: record.id,
      slug,
      kind: record.kind,
      serviceId: record.serviceId,
      serviceName: record.serviceName,
      specialistId: record.specialistId,
      hallId: record.hallId,
      startsAtMs: new Date(record.startsAt as string).getTime(),
      endsAtMs: new Date(record.endsAt as string).getTime(),
      allDay: record.allDay,
      dayCount: record.dayCount,
      status: record.status,
      client: record.client,
      price: record.price,
      paidTotal: Number(record.paidTotal ?? 0),
      deliverablesUrl: record.deliverablesUrl ?? undefined,
      token,
      createdAtMs: new Date(record.createdAt as string).getTime(),
      source: record.source,
      offsite: record.offsite,
      travelZoneId: record.travelZoneId,
      consent: record.consent,
    })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Ошибка' }, 500)
  }
})
