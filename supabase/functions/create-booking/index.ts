import { z } from 'npm:zod'
import { json, preflight } from '../_shared/cors.ts'
import { rateLimit } from '../_shared/limits.ts'
import { loadStudioData } from '../_shared/studio.ts'
import { createBookingSchema } from '../_shared/core/schema.ts'
import { calculatePrice } from '../_shared/core/price.ts'
import { bookingBlockSpan } from '../_shared/core/availability.ts'
import { addDaysToDateString, zonedToUtcMs } from '../_shared/core/time.ts'
import { supabaseAdmin } from '../_shared/supabaseAdmin.ts'

Deno.serve(async (req) => {
  const pf = preflight(req)
  if (pf) return pf
  try {
    const parsed = createBookingSchema.safeParse(await req.json())
    if (!parsed.success) {
      return json({ ok: false, error: 'Проверьте форму: ' + parsed.error.issues[0]?.message }, 400)
    }
    const p = parsed.data
    if (p.honeypot) return json({ ok: false, error: 'Заявка отклонена' }, 400)

    const ip = req.headers.get('x-forwarded-for') ?? 'anon'
    if (!(await rateLimit(`book:${p.slug}:${ip}`, 10))) return json({ ok: false, error: 'Слишком много попыток, попробуйте позже' }, 429)

    const studio = await loadStudioData(p.slug)
    if (!studio) return json({ ok: false, error: 'Студия не найдена' }, 404)
    const service = studio.services.find((s) => s.id === p.serviceId)
    if (!service) return json({ ok: false, error: 'Услуга не найдена' }, 404)
    if (p.kind !== service.kind) return json({ ok: false, error: 'Тип услуги не совпадает' }, 400)

    const hall = service.needsHall ? studio.halls.find((h) => h.id === p.hallId && h.active) : null
    if (service.needsHall && !hall) return json({ ok: false, error: 'Выберите зал' }, 400)
    const specialist = service.needsSpecialist
      ? p.specialistId
        ? studio.specialists.find((s) => s.id === p.specialistId && s.active)
        : null
      : null
    if (p.specialistId && !specialist) return json({ ok: false, error: 'Специалист недоступен' }, 400)

    const zone = studio.settings.travelZones.find((z) => z.id === p.travelZoneId)
    const offsite = Boolean(p.offsite)
    const durationMin = p.durationMin ?? service.durationMin

    // Цена всегда считается на сервере по одной чистой функции
    const price = calculatePrice({
      service,
      hall,
      tz: studio.settings.tz,
      startUtcMs: p.startUtcMs,
      durationMin,
      peopleCount: p.peopleCount,
      selectedAddonIds: p.addonIds ?? [],
      addons: studio.addons,
      travelZone: offsite ? zone ?? null : null,
      eveningFrom: studio.settings.eveningFrom,
    })

    const dayCount = service.multiDayMax > 1 ? (p.dayCount ?? 1) : 1
    const dateFrom = new Date(p.startUtcMs).toISOString().slice(0, 10)

    // Интервалы блокировки: буферы + дорога; полный день/многодневные — целые окна дней
    const resources: { resourceType: string; resourceId: string; start: string; end: string }[] = []
    if (service.fullDay || dayCount > 1) {
      for (let i = 0; i < dayCount; i++) {
        const date = addDaysToDateString(dateFrom, i)
        const win = studio.settings.schedule[
          ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(date + 'T00:00:00Z').getUTCDay()] as keyof typeof studio.settings.schedule
        ]
        if (!win) return json({ ok: false, error: `День ${date} закрыт` }, 400)
        const start = zonedToUtcMs(studio.settings.tz, date, win.open)
        const end = zonedToUtcMs(studio.settings.tz, date, win.close)
        if (service.needsHall && hall) resources.push({ resourceType: 'hall', resourceId: hall.id, start: new Date(start).toISOString(), end: new Date(end).toISOString() })
        if (service.needsSpecialist) {
          const sp = specialist ?? null
          if (!sp) return json({ ok: false, error: 'Выберите специалиста' }, 400)
          resources.push({ resourceType: 'specialist', resourceId: sp.id, start: new Date(start).toISOString(), end: new Date(end).toISOString() })
        }
      }
    } else {
      const span = bookingBlockSpan(service, p.startUtcMs, durationMin, offsite, zone?.minutesBefore ?? 0, zone?.minutesAfter ?? 0)
      const iso = (ms: number) => new Date(ms).toISOString()
      if (service.needsHall && hall) resources.push({ resourceType: 'hall', resourceId: hall.id, start: iso(span.startMs), end: iso(span.endMs) })
      if (service.needsSpecialist) {
        if (!specialist) return json({ ok: false, error: 'Выберите специалиста' }, 400)
        resources.push({ resourceType: 'specialist', resourceId: specialist.id, start: iso(span.startMs), end: iso(span.endMs) })
      }
    }

    const startsAt = new Date(p.startUtcMs).toISOString()
    const endsAt = new Date(p.startUtcMs + durationMin * 60_000).toISOString()

    const { data, error } = await supabaseAdmin().rpc('create_booking_rpc', {
      p_payload: {
        studioId: studio.id,
        slug: p.slug,
        kind: p.kind,
        serviceId: service.id,
        serviceName: service.name,
        specialistId: specialist?.id ?? null,
        hallId: hall?.id ?? null,
        startsAt,
        endsAt,
        allDay: service.fullDay,
        dayCount,
        status: service.autoConfirm ? 'confirmed' : 'new',
        client: { ...p.client, people: p.peopleCount },
        price,
        idempotencyKey: p.idempotencyKey,
        offsite,
        travelZoneId: offsite ? zone?.id ?? null : null,
        consent: { version: p.consent === true ? 'v1-draft' : 'none', at: new Date().toISOString(), accepted: p.consent },
        references: [],
      },
      p_resources: resources,
    })

    if (error) {
      const msg = String(error.message)
      if (msg.includes('booking_resources_no_overlap') || msg.includes('23P01')) {
        return json({ ok: false, error: 'Это время только что заняли. Выберите другое' }, 409)
      }
      if (msg.includes('bookings_idempotencyKey_key')) {
        return json({ ok: false, error: 'Заявка уже отправлена' }, 409)
      }
      return json({ ok: false, error: 'Не удалось сохранить заявку' }, 500)
    }

    const res = data as { token: string; existing: boolean }

    // Уведомление владельцу — через outbox (каналы: email/webpush), доставку делает notify-dispatch
    await supabaseAdmin().from('notify_outbox').insert({
      studioId: studio.id,
      channel: 'new_booking',
      payload: {
        title: `Новая заявка: ${service.name}`,
        body: `${p.client.name}, ${p.client.phone}, ${new Date(startsAt).toLocaleString('ru-RU')}`,
        bookingStart: startsAt,
      },
    })
    // best-effort доставка
    try {
      await EdgeRuntime.waitUntil(
        fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notify-dispatch`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
        })
      )
    } catch {}

    return json(res.existing ? { ok: true, token: res.token, duplicate: true } : { ok: true, token: res.token })
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : 'Ошибка' }, 500)
  }
})
