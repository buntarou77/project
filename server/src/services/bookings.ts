import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { bookingBlockSpan, canCancelByPolicy } from '../../../src/core/availability'
import { buildFullDayWindows, calculatePrice } from '../../../src/core/price'
import type { BookingRecord } from '../../../src/backend/types'
import type { Service, TenantSettings } from '../../../src/core/types'
import { utcToZonedDate, utcToZonedTime, windowDurationMin, zonedToUtcMs, weekdayKeyOfDate } from '../../../src/core/time'
import { query, tx } from '../db'
import { config } from '../config'
import { badRequest, conflict, notFound } from '../middleware/errors'
import { mapBooking } from '../mapping'
import { sha256Hex } from './tokens'
import { enqueueNotify } from './notify'
import { getSlots } from './availability'
import { loadStudioBundle } from './catalog'

export interface ResourceInterval {
  resourceType: 'specialist' | 'hall'
  resourceId: string
  startISO: string
  endISO: string
}

// Интервалы блокировки: буферы + дорога; полный день/многодневные — целые окна дней.
// Порт логики edge create-booking (§2.1 — только ядро считает span).
export function buildResourceIntervals(opts: {
  settings: TenantSettings
  service: Pick<Service, 'setupMin' | 'cleanupMin' | 'fullDay'> | null
  hallId: string | null
  specialistId?: string | null
  specialistIds?: string[] | null
  startMs: number
  durationMin: number
  dayCount: number
  offsite: boolean
  travelZoneId: string | null
}): ResourceInterval[] {
  const { settings, service, hallId, startMs, durationMin, dayCount, offsite, travelZoneId } = opts
  const specialistIds = opts.specialistIds?.length
    ? opts.specialistIds
    : opts.specialistId
      ? [opts.specialistId]
      : []
  const zone = settings.travelZones.find((z) => z.id === travelZoneId)
  const out: ResourceInterval[] = []

  const push = (type: 'specialist' | 'hall', id: string, sMs: number, eMs: number) => {
    out.push({ resourceType: type, resourceId: id, startISO: new Date(sMs).toISOString(), endISO: new Date(eMs).toISOString() })
  }

  if ((service?.fullDay ?? false) || dayCount > 1) {
    // дата первого дня — в таймзоне студии, не в UTC (иначе сдвиг на сутки
    // для восточных поясов и несовпадение с availability)
    const firstDate = utcToZonedDate(settings.tz, startMs)
    for (let i = 0; i < Math.max(1, dayCount); i++) {
      const date = addDays(firstDate, i)
      const win = settings.schedule[weekdayKeyOfDate(date)]
      if (!win) continue
      const s = zonedToUtcMs(settings.tz, date, win.open)
      // Y1: ночное окно кончается на следующие сутки
      const e = s + windowDurationMin(win.open, win.close) * 60_000
      if (hallId) push('hall', hallId, s, e)
      for (const id of specialistIds) push('specialist', id, s, e)
    }
    return out
  }

  const span = bookingBlockSpan(
    {
      setupMin: service?.setupMin ?? 0,
      cleanupMin: service?.cleanupMin ?? 0,
      fullDay: false,
    } as never,
    startMs,
    durationMin,
    offsite,
    offsite ? (zone?.minutesBefore ?? 0) : 0,
    offsite ? (zone?.minutesAfter ?? 0) : 0
  )
  if (hallId) push('hall', hallId, span.startMs, span.endMs)
  for (const id of specialistIds) push('specialist', id, span.startMs, span.endMs)
  return out
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface NewBookingInput {
  studioId: string
  slug: string
  kind: 'shoot' | 'rental'
  serviceId: string | null
  serviceName: string
  specialistId: string | null
  specialistIds?: string[] | null
  hallId: string | null
  startsAtMs: number
  endsAtMs: number
  allDay: boolean
  dayCount: number
  status: BookingRecord['status']
  client: BookingRecord['client']
  price: BookingRecord['price']
  source: 'web' | 'manual'
  offsite: boolean
  travelZoneId: string | null
  consent: Record<string, unknown>
  idempotencyKey: string | null
  references?: unknown[]
  paidTotal?: number
  // false — заявка, созданная сразу закрытым статусом, ресурсы не блокирует
  block?: boolean
  // для блокировок
  settings: TenantSettings
  service: Pick<Service, 'setupMin' | 'cleanupMin' | 'fullDay'> | null
}

const isPgError = (e: unknown, code: string) =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === code

// Одна неделимая операция: заявка + блокировки ресурсов (принцип §2.3).
// 23P01 (пересечение) → 409; повтор idempotency_key → существующая заявка, duplicate.
export async function insertBookingWithResources(
  input: NewBookingInput
): Promise<{ record: BookingRecord; token: string | null; duplicate: boolean }> {
  const secret = randomUUID()
  const tokenHash = sha256Hex(secret)
  const specialistIds = input.specialistIds?.length
    ? input.specialistIds
    : input.specialistId
      ? [input.specialistId]
      : []
  const primarySpecialistId = specialistIds[0] ?? null
  try {
    const result = await tx(async (c) => {
      const ins = await c.query(
        `insert into bookings
         (studio_id, kind, service_id, service_name, specialist_id, specialist_ids, hall_id,
          starts_at, ends_at, all_day, day_count, status, client, "references", price,
          paid_total, access_token_hash, idempotency_key, source, offsite, travel_zone_id, consent)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         on conflict (studio_id, idempotency_key) do nothing
         returning *`,
        [
          input.studioId, input.kind, input.serviceId, input.serviceName,
          primarySpecialistId, JSON.stringify(specialistIds), input.hallId,
          new Date(input.startsAtMs), new Date(input.endsAtMs),
          input.allDay, input.dayCount, input.status,
          JSON.stringify(input.client), JSON.stringify(input.references ?? []),
          JSON.stringify(input.price), input.paidTotal ?? 0, tokenHash, input.idempotencyKey,
          input.source, input.offsite, input.travelZoneId, JSON.stringify(input.consent),
        ]
      )
      if (ins.rows.length === 0) {
        const existing = await c.query(
          `select b.*, s.slug from bookings b join studios s on s.id = b.studio_id
           where b.studio_id = $1 and b.idempotency_key = $2`,
          [input.studioId, input.idempotencyKey]
        )
        return { record: mapBooking(existing.rows[0], input.slug), duplicate: true }
      }
      const row = ins.rows[0]
      const intervals =
        input.block === false
          ? []
          : buildResourceIntervals({
              settings: input.settings,
              service: input.service,
              hallId: input.hallId,
              specialistIds,
              startMs: input.startsAtMs,
              durationMin: (input.endsAtMs - input.startsAtMs) / 60_000,
              dayCount: input.dayCount,
              offsite: input.offsite,
              travelZoneId: input.travelZoneId,
            })
      for (const r of intervals) {
        await c.query(
          `insert into booking_resources (booking_id, studio_id, resource_type, resource_id, during)
           values ($1, $2, $3, $4, tstzrange($5, $6, '[)'))`,
          [row.id, input.studioId, r.resourceType, r.resourceId, r.startISO, r.endISO]
        )
      }
      return { record: mapBooking(row, input.slug), duplicate: false }
    })
    // Секрет возвращается только при фактическом создании: в дубликате он не
    // соответствует хешу существующей записи, токен фронт уже сохранил ранее.
    return { record: result.record, token: result.duplicate ? null : secret, duplicate: result.duplicate }
  } catch (e) {
    if (isPgError(e, '23P01')) {
      throw conflict('BOOKING_CONFLICT', 'Это время только что заняли. Выберите другое')
    }
    throw e
  }
}

// Повтор с тем же idempotency_key: вернуть существующую заявку как duplicate.
export async function findDuplicate(studioId: string, slug: string, idempotencyKey: string): Promise<BookingRecord | null> {
  const r = await query(
    `select b.*, s.slug from bookings b join studios s on s.id = b.studio_id
     where b.studio_id = $1 and b.idempotency_key = $2`,
    [studioId, idempotencyKey]
  )
  return r.rows[0] ? mapBooking(r.rows[0], slug) : null
}

export function publicBookingResponse(
  record: BookingRecord,
  token: string | null,
  duplicate: boolean
): { ok: true; token?: string; duplicate?: boolean; price?: BookingRecord['price'] } {
  const out: { ok: true; token?: string; duplicate?: boolean; price?: BookingRecord['price'] } = { ok: true }
  if (token) out.token = token
  if (duplicate) out.duplicate = true
  // серверная цена — фронт показывает её на экране успеха вместо своей оценки
  if (!duplicate) out.price = record.price
  return out
}

// Секрет доступен только в момент создания: дубликат возвращает запись без токена,
// фронтенд сохраняет токен из первого ответа (bookingStorage).
export async function createPublicBooking(opts: {
  studioId: string
  slug: string
  settings: TenantSettings
  service: Service
  hall: import('../../../src/core/types').Hall | null
  // разрешённые залы услуги (после белого списка и active) — для авто-подбора
  halls: import('../../../src/core/types').Hall[]
  addons: import('../../../src/core/types').Addon[]
  specialists: import('../../../src/core/types').Specialist[]
  payload: Omit<
    import('../../../src/core/schema').CreateBookingPayload,
    'slug'
  >
}): Promise<{ ok: true; token?: string; duplicate?: boolean }> {
  const { settings, service, payload } = opts
  const zone = settings.travelZones.find((z) => z.id === payload.travelZoneId) ?? null
  const offsite = Boolean(payload.offsite)
  // «Весь день»: длительность и конец — по окнам графика студии, цена — часы окон.
  // Сверху dayCount зажат multiDayMax: схема пускает до 5, лимит дней ставит услуга
  const dayCount = service.multiDayMax > 1 ? Math.min(service.multiDayMax, payload.dayCount ?? 1) : 1
  // Окна дней нужны не только «всему дню»: многодневная бронь (даже не fullDay)
  // кончается закрытием последнего дня и занимает целые окна (perDayBlocking)
  const fdw =
    service.fullDay || dayCount > 1
      ? buildFullDayWindows(settings.schedule, settings.tz, payload.startUtcMs, dayCount)
      : null
  const requestedMin = payload.durationMin ?? service.durationMin
  // фикс-пакет: оплачено k пакетов — столько же времени бронь занимает
  const k =
    service.priceType === 'fixed'
      ? Math.max(1, Math.ceil(requestedMin / service.durationMin))
      : 1
  const durationMin = fdw ? fdw.totalMinutes : requestedMin
  const endsAtMs = fdw
    ? fdw.lastCloseMs
    : service.priceType === 'fixed'
      ? payload.startUtcMs + k * service.durationMin * 60_000
      : payload.startUtcMs + durationMin * 60_000

  // Явно выбранный зал; null — сервис сам подберёт свободный разрешённый.
  let hall = opts.hall
  // аренда всегда занимает зал; съёмка — только если админ включил «нужен зал»
  const needHall = service.needsHall || service.kind === 'rental'
  const hallId = needHall ? (payload.hallId ?? null) : null
  if (needHall && hallId && hall) {
    // Явно выбранный зал проверяется тем же getSlots, что и автоподбор:
    // график, closedDates, прошлое, вместимость и пересечения — ядром
    const { slots } = await getSlots({
      studioId: opts.studioId,
      settings,
      specialists: opts.specialists,
      halls: [hall],
      services: [service],
      serviceId: service.id,
      dateFrom: utcToZonedDate(settings.tz, payload.startUtcMs),
      dayCount,
      durationMin,
      specialistId: null,
      hallId: hall.id,
      offsite,
      travelZoneId: zone?.id ?? null,
      peopleCount: payload.peopleCount,
    })
    if (!slots.some((s) => s.startMs === payload.startUtcMs)) {
      throw conflict('BOOKING_CONFLICT', 'Зал занят или недоступен в это время')
    }
  }
  if (needHall && !hallId) {
    const dateFrom = utcToZonedDate(settings.tz, payload.startUtcMs)
    for (const h of opts.halls) {
      const { slots } = await getSlots({
        studioId: opts.studioId,
        settings,
        specialists: opts.specialists,
        halls: [h],
        services: [service],
        serviceId: service.id,
        dateFrom,
        dayCount,
        durationMin,
        specialistId: null,
        hallId: h.id,
        offsite,
        travelZoneId: zone?.id ?? null,
        peopleCount: payload.peopleCount,
      })
      if (slots.some((s) => s.startMs === payload.startUtcMs)) {
        hall = h
        break
      }
    }
    if (!hall) throw conflict('BOOKING_CONFLICT', 'Свободного зала на это время нет')
  }

  // Услуга-команда: состав задан админом, клиент никого не выбирает.
  // Все участники должны быть активны и свободны на слоте.
  const teamIds = service.needsSpecialist && service.allSpecialistsRequired ? service.specialistIds ?? [] : []
  const teamSpecialists = teamIds
    .map((id) => opts.specialists.find((s) => s.id === id && s.active) ?? null)
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
  if (service.needsSpecialist && service.allSpecialistsRequired) {
    if (teamIds.length === 0) throw badRequest('В услуге не настроены специалисты')
    if (teamSpecialists.length !== teamIds.length) throw badRequest('Не все специалисты услуги доступны')
  }
  const isTeam = teamIds.length > 0

  // «Любой свободный»: сервер сам выбирает свободного специалиста на слот и
  // блокирует именно его. Иначе заявка не занимала бы никого (§8-класс бага).
  let specialistId: string | null = isTeam
    ? teamSpecialists[0].id
    : payload.specialistId ?? null
  let specialistIds = isTeam
    ? teamSpecialists.map((s) => s.id)
    : specialistId
      ? [specialistId]
      : []
  if (service.needsSpecialist && !isTeam && !specialistId) {
    const { slots } = await getSlots({
      studioId: opts.studioId,
      settings,
      specialists: opts.specialists,
      halls: hall ? [hall] : [],
      services: [service],
      serviceId: service.id,
      dateFrom: utcToZonedDate(settings.tz, payload.startUtcMs),
      dayCount,
      durationMin,
      specialistId: null,
      hallId: hall?.id ?? null,
      offsite,
      travelZoneId: zone?.id ?? null,
      peopleCount: payload.peopleCount,
    })
    const match = slots.find((s) => s.startMs === payload.startUtcMs)
    if (!match?.specialistId) {
      throw conflict('BOOKING_CONFLICT', 'Свободного специалиста на это время нет')
    }
    specialistId = match.specialistId
    specialistIds = [match.specialistId]
  } else if (isTeam && !needHall) {
    // без зала (выезд) зал-цикл выше не проверял слот — проверяем команду
    const { slots } = await getSlots({
      studioId: opts.studioId,
      settings,
      specialists: opts.specialists,
      halls: [],
      services: [service],
      serviceId: service.id,
      dateFrom: utcToZonedDate(settings.tz, payload.startUtcMs),
      dayCount,
      durationMin,
      specialistId: null,
      hallId: null,
      offsite,
      travelZoneId: zone?.id ?? null,
      peopleCount: payload.peopleCount,
    })
    if (!slots.some((s) => s.startMs === payload.startUtcMs)) {
      throw conflict('BOOKING_CONFLICT', 'Специалисты недоступны в это время')
    }
  } else if (service.needsSpecialist && specialistId && !isTeam) {
    // Явно выбранный специалист проверяется тем же getSlots: график, лимит
    // съёмок в день, closedDates и занятость — ядром, не только EXCLUDE
    const { slots } = await getSlots({
      studioId: opts.studioId,
      settings,
      specialists: opts.specialists,
      halls: hall ? [hall] : [],
      services: [service],
      serviceId: service.id,
      dateFrom: utcToZonedDate(settings.tz, payload.startUtcMs),
      dayCount,
      durationMin,
      specialistId,
      hallId: hall?.id ?? null,
      offsite,
      travelZoneId: zone?.id ?? null,
      peopleCount: payload.peopleCount,
    })
    if (!slots.some((s) => s.startMs === payload.startUtcMs)) {
      throw conflict('BOOKING_CONFLICT', 'Специалист недоступен в это время')
    }
  }
  const specialistObj = !isTeam && specialistId
    ? opts.specialists.find((s) => s.id === specialistId) ?? null
    : null
  const priceSpecialists = (isTeam ? teamSpecialists : specialistObj ? [specialistObj] : [])
    .filter((s) => (s.hourRate ?? 0) > 0)
    .map((s) => ({ name: s.name, hourRate: s.hourRate! }))

  // Тарифы у залов разные: в авто-фолбэбе цена пересчитывается для каждого
  // кандидата, чтобы снапшот соответствовал фактически занятому залу
  const priceFor = (h: import('../../../src/core/types').Hall | null) =>
    calculatePrice({
      service,
      hall: h,
      tz: settings.tz,
      startUtcMs: payload.startUtcMs,
      // fullDay+fixed НЕ передаёт durationMin: иначе ядро посчитает ложную
      // кратность по суммарным минутам окон (нужно ровно цена × дни)
      durationMin: service.fullDay && service.priceType === 'fixed' ? undefined : durationMin,
      fullDayWindows: fdw?.windows,
      // Y2: многодневная почасовая тарифицируется по полным окнам — часы
      // выбора клиента влияют только на занятость, не на цену
      specialists: priceSpecialists.length > 0 ? priceSpecialists : null,
      peopleCount: payload.peopleCount,
      selectedAddonIds: payload.addonIds ?? [],
      addons: opts.addons,
      travelZone: offsite ? zone : null,
      eveningFrom: settings.eveningFrom,
    })

  const insert = (h: import('../../../src/core/types').Hall | null, price: BookingRecord['price']) =>
    insertBookingWithResources({
      studioId: opts.studioId,
      slug: opts.slug,
      kind: payload.kind,
      serviceId: service.id,
      serviceName: service.name,
      specialistId,
      specialistIds,
      hallId: needHall ? (h?.id ?? hallId) : null,
      startsAtMs: payload.startUtcMs,
      endsAtMs,
      allDay: service.fullDay,
      dayCount,
      status: service.autoConfirm ? 'confirmed' : 'new',
      client: { ...payload.client, people: payload.peopleCount },
      price,
      source: 'web',
      offsite,
      travelZoneId: offsite ? (zone?.id ?? null) : null,
      consent: { version: payload.consent ? 'v1-draft' : 'none', atMs: Date.now(), accepted: payload.consent },
      idempotencyKey: payload.idempotencyKey,
      settings,
      service,
    })

  let result
  if (needHall && !hallId) {
    // Зал подобран автоматически; при гонке (23P01) пробуем следующий
    // разрешённый — ровно один зал свободен не был, остальные могли
    // остаться свободными. EXCLUDE CONSTRAINT — финальный судья.
    const order = [hall, ...opts.halls.filter((h) => h.id !== hall!.id)]
    for (const h of order) {
      try {
        result = await insert(h, priceFor(h))
        break
      } catch (e) {
        const isConflict =
          typeof e === 'object' && e !== null && (e as { code?: string }).code === 'BOOKING_CONFLICT'
        if (!isConflict) throw e
      }
    }
    if (!result) throw conflict('BOOKING_CONFLICT', 'Это время только что заняли. Выберите другое')
  } else {
    // Явно выбранный зал (или без зала) — одна попытка: молчаливо подменять
    // зал клиента нельзя; 23P01 → 409 из insertBookingWithResources
    result = await insert(hall, priceFor(hall))
  }

  if (!result.duplicate) {
    // «Напоминание за сутки» с экрана успеха витрины: строка в outbox с
    // отложенным next_attempt_at — воркер отправит push, когда время придёт
    const remindAtMs = payload.startUtcMs - 24 * 3_600_000
    if (remindAtMs > Date.now()) {
      await enqueueNotify(
        opts.studioId,
        'reminder_client',
        {
          title: 'Напоминание о записи',
          body: `${service.name}, ${utcToZonedDate(settings.tz, payload.startUtcMs)} ${utcToZonedTime(settings.tz, payload.startUtcMs)}`,
          // SW витрины показывает icon и открывает url по клику
          icon: `/s/${opts.slug}/icons/icon-192.png`,
          url: `/s/${opts.slug}`,
        },
        result.record.id,
        new Date(remindAtMs)
      )
    }
    await enqueueNotify(
      opts.studioId,
      'new_booking',
      {
        title: `Новая заявка: ${service.name}`,
        // C9: push виден на лок-скрине — без телефона; полный контакт — в письме
        body: `${payload.client.name}, ${utcToZonedDate(settings.tz, payload.startUtcMs)} ${utcToZonedTime(settings.tz, payload.startUtcMs)}`,
      },
      result.record.id
    )
  }
  return publicBookingResponse(result.record, result.token, result.duplicate)
}

export async function getBookingByTokenHash(
  studioId: string,
  slug: string,
  token: string
): Promise<BookingRecord | null> {
  const r = await query(
    `select b.*, s.slug from bookings b join studios s on s.id = b.studio_id
     where b.studio_id = $1 and b.access_token_hash = $2`,
    [studioId, sha256Hex(token)]
  )
  return r.rows[0] ? mapBooking(r.rows[0], slug) : null
}

// §8.1: отмена снимает блокировки в той же транзакции.
export async function cancelByToken(
  studioId: string,
  slug: string,
  token: string,
  settings: TenantSettings
): Promise<{ ok: true } | { ok: false; error: string }> {
  return tx(async (c) => {
    const r = await c.query(
      `select b.*, s.slug from bookings b join studios s on s.id = b.studio_id
       where b.studio_id = $1 and b.access_token_hash = $2 for update`,
      [studioId, sha256Hex(token)]
    )
    if (r.rows.length === 0) throw notFound('Запись не найдена')
    const row = r.rows[0]
    const can = canCancelByPolicy({
      startsAtMs: new Date(row.starts_at).getTime(),
      freeHours: settings.cancellation.freeHours,
      nowMs: Date.now(),
      status: row.status,
    })
    if (!can.allowed) throw conflict('CANCEL_WINDOW_CLOSED', can.reason ?? 'Отмена недоступна')
    await c.query(`update bookings set status='cancelled_by_client', updated_at=now() where id=$1`, [row.id])
    await c.query(`delete from booking_resources where booking_id=$1`, [row.id])
    // суточное напоминание неактуально; статуса 'cancelled' в check-констрейнте
    // notify_outbox нет — удаляем pending-строку в той же транзакции
    await c.query(
      `delete from notify_outbox where booking_id=$1 and channel='reminder_client' and status in ('pending','processing')`,
      [row.id]
    )
    return { ok: true as const }
  })
}

export interface ListFilters {
  status?: string
  specialistId?: string
  hallId?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
  cursor?: number
  tz: string // C2: границы дат считаем в таймзоне студии, не в UTC
}

// Список кабинета; финансы гасятся на роуте для ролей без finance:read (§3).
export async function listBookings(
  studioId: string,
  slug: string,
  filters: ListFilters
): Promise<{ items: BookingRecord[]; nextCursor: number | null }> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500)
  const offset = Math.max(filters.cursor ?? 0, 0)
  const where: string[] = ['b.studio_id = $1']
  const params: unknown[] = [studioId]
  if (filters.status && filters.status !== 'all') {
    if (filters.status === 'active') {
      params.push(['new', 'confirmed', 'prepaid', 'shot_done', 'processing', 'delivered'])
      where.push(`b.status = any($${params.length})`)
    } else {
      params.push(filters.status)
      where.push(`b.status = $${params.length}`)
    }
  }
  if (filters.specialistId) {
    params.push(filters.specialistId)
    where.push(
      `(b.specialist_id = $${params.length} or coalesce(b.specialist_ids, '[]'::jsonb) @> to_jsonb($${params.length}::text))`
    )
  }
  if (filters.hallId) {
    params.push(filters.hallId)
    where.push(`b.hall_id = $${params.length}`)
  }
  if (filters.dateFrom) {
    params.push(new Date(zonedToUtcMs(filters.tz, filters.dateFrom, '00:00')))
    where.push(`b.starts_at >= $${params.length}`)
  }
  if (filters.dateTo) {
    params.push(new Date(zonedToUtcMs(filters.tz, filters.dateTo, '23:59') + 59_000))
    where.push(`b.starts_at <= $${params.length}`)
  }
  params.push(limit + 1, offset)
  const r = await query(
    `select b.*, s.slug from bookings b join studios s on s.id = b.studio_id
     where ${where.join(' and ')}
     order by b.starts_at, b.id limit $${params.length - 1} offset $${params.length}`,
    params
  )
  const items = r.rows.slice(0, limit).map((row) => mapBooking(row, slug))
  const nextCursor = r.rows.length > limit ? offset + limit : null
  return { items, nextCursor }
}

export async function getBookingById(studioId: string, slug: string, id: string): Promise<BookingRecord | null> {
  const r = await query(
    `select b.*, s.slug from bookings b join studios s on s.id = b.studio_id
     where b.studio_id = $1 and b.id = $2`,
    [studioId, id]
  )
  return r.rows[0] ? mapBooking(r.rows[0], slug) : null
}

export interface PatchInput {
  status?: BookingRecord['status']
  paidTotal?: number
  deliverablesUrl?: string
  startsAtMs?: number
  endsAtMs?: number
}

// Цепочка активных статусов (индексы имеют значение) и закрытые статусы.
const STATUS_CHAIN = ['new', 'confirmed', 'prepaid', 'shot_done', 'processing', 'delivered', 'completed']
const STATUS_CLOSED = ['cancelled_by_client', 'rejected', 'no_show']
// completed — закрывающий (C1): блокировки снимаются, ре-открытие пересоздаёт
export const CLOSING_STATUSES = [...STATUS_CLOSED, 'completed']

// Матрица переходов (C2): из закрывающего (вкл. completed) — куда угодно
// (ре-открытие/смена причины); активный → закрывающий — ок; активный →
// активный — вперёд на любой следующий (владелец может перескочить этапы),
// назад — ровно на один шаг (откат ошибочного клика).
function assertStatusTransition(oldStatus: string, newStatus: string): void {
  if (oldStatus === newStatus) return
  if (CLOSING_STATUSES.includes(oldStatus)) return
  if (CLOSING_STATUSES.includes(newStatus)) return
  const i = STATUS_CHAIN.indexOf(oldStatus)
  const j = STATUS_CHAIN.indexOf(newStatus)
  if (i !== -1 && j !== -1 && (j > i || i - j === 1)) return
  throw badRequest(`Недопустимый переход статуса: ${oldStatus} → ${newStatus}`, 'INVALID_STATUS_TRANSITION')
}

// §8.1/§8.2: закрытие (вкл. completed) снимает блокировки, перенос —
// пересоздаёт; ре-открытие (из закрывающего статуса в активный) — тоже
// пересоздаёт, иначе заявка никого не занимала.
export async function updateBooking(
  studio: { id: string; slug: string; settings: TenantSettings },
  id: string,
  patch: PatchInput
): Promise<BookingRecord> {
  let updated: BookingRecord
  try {
    updated = await tx(async (c) => {
      const cur = await c.query(
        `select b.*, s.slug from bookings b join studios s on s.id = b.studio_id
         where b.studio_id = $1 and b.id = $2 for update`,
        [studio.id, id]
      )
      if (cur.rows.length === 0) throw notFound('Заявка не найдена')
      const row = cur.rows[0]
      const oldStatus = row.status as string
      const rowSpecialistIds = (row.specialist_ids as string[] | null)?.length
        ? (row.specialist_ids as string[])
        : row.specialist_id
          ? [row.specialist_id as string]
          : []

      let startsAtMs = new Date(row.starts_at).getTime()
      let endsAtMs = new Date(row.ends_at).getTime()
      if (patch.startsAtMs !== undefined) startsAtMs = patch.startsAtMs
      if (patch.endsAtMs !== undefined) endsAtMs = patch.endsAtMs
      // перевёрнутый интервал после патча — 400 до любых записей в БД
      if ((patch.startsAtMs !== undefined || patch.endsAtMs !== undefined) && endsAtMs <= startsAtMs) {
        throw badRequest('Конец брони должен быть позже начала')
      }

      let service: Pick<Service, 'setupMin' | 'cleanupMin' | 'fullDay'> | null = null
      if (row.service_id) {
        const s = await c.query(`select setup_min, cleanup_min, full_day from services where id = $1`, [row.service_id])
        if (s.rows[0]) {
          service = {
            setupMin: s.rows[0].setup_min,
            cleanupMin: s.rows[0].cleanup_min,
            fullDay: s.rows[0].full_day,
          }
        }
      }

      const newStatus = patch.status ?? oldStatus
      // C2: смена статуса — только по матрице переходов (ручное создание не ограничено)
      if (patch.status !== undefined && patch.status !== oldStatus) {
        assertStatusTransition(oldStatus, patch.status)
      }
      const closing = CLOSING_STATUSES.includes(newStatus)
      const wasClosed = CLOSING_STATUSES.includes(oldStatus)
      const resize = patch.startsAtMs !== undefined || patch.endsAtMs !== undefined
      const reopen = wasClosed && !closing

      // Перенос/ре-открытие валидируются тем же getSlots, что и витрина: без
      // этого владелец мог бы унести бронь на ночь/выходной/закрытую дату.
      // EXCLUDE остаётся финальным судьёй на случай гонки. Удалённая услуга —
      // пропускаем (снимок имени в брони живёт без каталога).
      if ((resize || reopen) && !closing && row.service_id) {
        const bundle = await loadStudioBundle(studio.id, studio.slug)
        const svc = bundle.services.find((s) => s.id === row.service_id)
        if (svc) {
          const { slots } = await getSlots({
            studioId: studio.id,
            settings: studio.settings,
            specialists: bundle.specialists,
            halls: bundle.halls,
            services: [svc],
            serviceId: svc.id,
            dateFrom: utcToZonedDate(studio.settings.tz, startsAtMs),
            dayCount: row.day_count,
            durationMin: (endsAtMs - startsAtMs) / 60_000,
            specialistId: row.specialist_id,
            hallId: row.hall_id,
            offsite: row.offsite,
            travelZoneId: row.travel_zone_id,
            excludeBookingId: id,
          })
          if (!slots.some((s) => s.startMs === startsAtMs)) {
            throw conflict('BOOKING_CONFLICT', 'Время вне графика или занято')
          }
        }
      }

      // П3: full-day/многодневная бронь обязана покрыть все свои дни:
      // часть дней закрыта → бронь молча урежется, запрещаем на сервере
      if ((row.all_day || row.day_count > 1) && resize) {
        const expectedDays = row.day_count > 1 ? row.day_count : 1
        const fdw = buildFullDayWindows(
          studio.settings.schedule,
          studio.settings.tz,
          startsAtMs,
          expectedDays
        )
        if (fdw.windows.length !== expectedDays) {
          throw badRequest('В выбранных днях есть закрытые — перенос невозможен')
        }
      }

      const updates: string[] = ['updated_at = now()']
      const params: unknown[] = []
      if (patch.status !== undefined) {
        params.push(patch.status)
        updates.push(`status = $${params.length}`)
      }
      if (patch.paidTotal !== undefined) {
        params.push(patch.paidTotal)
        updates.push(`paid_total = $${params.length}`)
      }
      if (patch.deliverablesUrl !== undefined) {
        params.push(patch.deliverablesUrl)
        updates.push(`deliverables_url = $${params.length}`)
      }
      if (patch.startsAtMs !== undefined || patch.endsAtMs !== undefined) {
        params.push(new Date(startsAtMs), new Date(endsAtMs))
        updates.push(`starts_at = $${params.length - 1}`, `ends_at = $${params.length}`)
      }
      params.push(id, studio.id)
      const res = await c.query(
        `update bookings set ${updates.join(', ')} where id = $${params.length - 1} and studio_id = $${params.length} returning *`,
        params
      )

      if (resize || reopen) {
        // пересоздание: старые интервалы долой, новые с актуальными буферами;
        // пересечение → 23P01 → конфликт, транзакция откатывается
        await c.query(`delete from booking_resources where booking_id = $1`, [id])
        if (!closing) {
          const intervals = buildResourceIntervals({
            settings: studio.settings,
            service,
            hallId: row.hall_id,
            specialistIds: rowSpecialistIds,
            startMs: startsAtMs,
            durationMin: (endsAtMs - startsAtMs) / 60_000,
            dayCount: row.day_count,
            offsite: row.offsite,
            travelZoneId: row.travel_zone_id,
          })
          for (const r of intervals) {
            await c.query(
              `insert into booking_resources (booking_id, studio_id, resource_type, resource_id, during)
               values ($1, $2, $3, $4, tstzrange($5, $6, '[)'))`,
              [id, studio.id, r.resourceType, r.resourceId, r.startISO, r.endISO]
            )
          }
        }
      } else if (closing) {
        await c.query(`delete from booking_resources where booking_id = $1`, [id])
      }

      // П2: напоминание клиенту живёт по актуальному времени брони.
      // closing — гасим; resize — пересоздаём с новым sendAt и текстом.
      if (closing) {
        await c.query(
          `delete from notify_outbox where booking_id = $1 and channel = 'reminder_client' and status in ('pending','processing')`,
          [id]
        )
      } else if (resize) {
        await c.query(
          `delete from notify_outbox where booking_id = $1 and channel = 'reminder_client' and status in ('pending','processing')`,
          [id]
        )
        const remindAtMs = startsAtMs - 24 * 3_600_000
        // Создание напоминания в createPublicBooking не зависит от статуса —
        // сохраняем паритет и при переносе (в т.ч. для new).
        if (remindAtMs > Date.now()) {
          await c.query(
            `insert into notify_outbox (studio_id, booking_id, channel, payload, next_attempt_at)
             values ($1, $2, 'reminder_client', $3, $4)`,
            [
              studio.id,
              id,
              JSON.stringify({
                title: 'Напоминание о записи',
                body: `${row.service_name}, ${utcToZonedDate(studio.settings.tz, startsAtMs)} ${utcToZonedTime(studio.settings.tz, startsAtMs)}`,
                icon: `/s/${studio.slug}/icons/icon-192.png`,
                url: `/s/${studio.slug}`,
              }),
              new Date(remindAtMs),
            ]
          )
        }
      }
      return mapBooking(res.rows[0], studio.slug)
    })
  } catch (e) {
    // перенос/resize на занятое время: сырой pg 23P01 → 409, а не 500 INTERNAL
    if (isPgError(e, '23P01')) {
      throw conflict('BOOKING_CONFLICT', 'Это время уже занято другим ресурсом')
    }
    throw e
  }
  return updated
}

// ---------- Y3: референсы клиента (приватные файлы) ----------

export interface ReferenceItem {
  id: string
  url: string
  sort: number
}

// Сохранить файлы референсов брони. Возвращает количество или null, если
// бронь по токену не найдена. Лимит 5 на бронь: лишние отбрасываются молча —
// форма витрины режет выбор до 5 ещё на клиенте, сервер дублирует защиту.
export async function saveReferenceFiles(
  studioId: string,
  token: string,
  files: Express.Multer.File[]
): Promise<number | null> {
  const booking = await getBookingByTokenHash(studioId, '', token)
  if (!booking) return null
  const existing = await query<{ n: number }>(
    `select count(*)::int n from booking_references where studio_id = $1 and booking_id = $2`,
    [studioId, booking.id]
  )
  const room = Math.max(0, 5 - existing.rows[0].n)
  const batch = files.slice(0, room)
  const dir = path.join(config.UPLOADS_DIR, studioId, 'references')
  mkdirSync(dir, { recursive: true })
  for (const [i, f] of batch.entries()) {
    const uuid = randomUUID()
    const ext = f.mimetype === 'image/png' ? '.png' : f.mimetype === 'image/webp' ? '.webp' : '.jpg'
    const rel = `${studioId}/references/${uuid}${ext}`
    writeFileSync(path.join(config.UPLOADS_DIR, rel), f.buffer)
    await query(
      `insert into booking_references (studio_id, booking_id, file_path, mime, size_bytes, sort)
       values ($1, $2, $3, $4, $5, $6)`,
      [studioId, booking.id, rel, f.mimetype, f.size, existing.rows[0].n + i]
    )
  }
  return batch.length
}

// Список референсов. owner=true — из кабинета (без проверки токена брони),
// иначе — по секретному токену клиента.
export async function listReferences(
  studioId: string,
  bookingIdOrToken: string,
  owner: boolean
): Promise<ReferenceItem[]> {
  let bookingId = bookingIdOrToken
  if (!owner) {
    const booking = await getBookingByTokenHash(studioId, '', bookingIdOrToken)
    if (!booking) return []
    bookingId = booking.id
  }
  const r = await query<{ id: string; file_path: string; sort: number }>(
    `select id, file_path, sort from booking_references
     where studio_id = $1 and booking_id = $2 order by sort, created_at`,
    [studioId, bookingId]
  )
  // П1: прямой URL не выдаём — фронт строит ссылку на авторизованный file-endpoint
  return r.rows.map((row) => ({ id: row.id, url: '', sort: row.sort }))
}

// Удаление референсов брони (анонимизация/удаление брони) — файлы и строки.
export async function deleteReferences(studioId: string, bookingId: string): Promise<void> {
  const r = await query<{ file_path: string }>(
    `delete from booking_references where studio_id = $1 and booking_id = $2 returning file_path`,
    [studioId, bookingId]
  )
  for (const row of r.rows) {
    try {
      await unlink(path.join(config.UPLOADS_DIR, row.file_path))
    } catch {
      // файла уже нет — не страшно
    }
  }
}

// Анонимизация клиента по запросу на удаление данных (ФЗ-152).
// Заодно отзываем секретный токен записи: старая ссылка клиента перестаёт работать.
export async function anonymizeClient(studioId: string, bookingId: string): Promise<void> {
  await query(
    `update bookings set client = client || '{"name":"Данные удалены","phone":"удалено"}' || '{"notes":null}' || '{"referenceCount":null}',
      "references" = '[]', access_token_hash = $3, updated_at = now()
     where id = $1 and studio_id = $2`,
    [bookingId, studioId, sha256Hex(randomUUID())]
  )
  // Y3: файлы референсов — персональные данные, удаляем вместе с анонимизацией
  await deleteReferences(studioId, bookingId)
}
