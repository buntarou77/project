import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { query } from '../db'
import { buildBundle, mapAddon, mapHall, mapPortfolio, mapService, mapSpecialist, mapStudio } from '../mapping'
import type { BookingRecord, StudioBundle } from '../../../src/backend/types'
import type { Addon, ClosedPeriod, Hall, PortfolioItem, Service, Specialist } from '../../../src/core/types'
import { ApiHttpError } from '../middleware/errors'
import { config } from '../config'

export async function getStudioBySlug(slug: string) {
  const r = await query(`select * from studios where slug = $1`, [slug])
  return r.rows[0] ? mapStudio(r.rows[0]) : null
}

export async function loadStudioBundle(studioId: string, slug: string): Promise<StudioBundle> {
  const [studio, specialists, halls, services, addons, portfolio] = await Promise.all([
    query(`select * from studios where id = $1`, [studioId]),
    query(`select * from specialists where studio_id = $1 order by name`, [studioId]),
    query(`select * from halls where studio_id = $1 order by name`, [studioId]),
    query(`select * from services where studio_id = $1 order by sort`, [studioId]),
    query(`select * from addons where studio_id = $1 order by sort`, [studioId]),
    query(`select * from portfolio where studio_id = $1 order by sort`, [studioId]),
  ])
  if (studio.rows.length === 0) throw new ApiHttpError(404, 'NOT_FOUND', 'Студия не найдена')
  return buildBundle(
    mapStudio(studio.rows[0]),
    specialists.rows.map(mapSpecialist),
    halls.rows.map(mapHall),
    services.rows.map(mapService),
    addons.rows.map(mapAddon),
    portfolio.rows.map(mapPortfolio)
  )
}

// ---------- upserts каталога (право catalog:write проверяет middleware) ----------

export async function upsertSpecialist(studioId: string, item: Specialist): Promise<void> {
  await query(
    `insert into specialists (id, studio_id, name, title, active, day_limit, photo_url, show_on_team, schedule, hour_rate)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (id) do update set name=$3, title=$4, active=$5, day_limit=$6, photo_url=$7, show_on_team=$8, schedule=$9, hour_rate=$10
     where specialists.studio_id = $2`,
    [item.id, studioId, item.name, item.title, item.active, item.dayLimit, item.photoUrl ?? null, item.showOnTeam ?? true, item.schedule ? JSON.stringify(item.schedule) : null, item.hourRate ?? null]
  )
}

// Удаление специалиста: брони остаются (FK ON DELETE SET NULL, имя — снимок),
// фантомные блокировки времени и упоминания в белых списках услуг чистим сразу.
export async function deleteSpecialist(studioId: string, id: string): Promise<void> {
  await query(`delete from booking_resources where studio_id = $1 and resource_type = 'specialist' and resource_id = $2`, [studioId, id])
  await query(
    `update services set specialist_ids = (
       select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(specialist_ids) x
       where x <> to_jsonb($2::text)
     ) where studio_id = $1 and specialist_ids is not null`,
    [studioId, id]
  )
  await query(`delete from specialists where id = $1 and studio_id = $2`, [id, studioId])
}

export async function upsertHall(studioId: string, item: Hall): Promise<void> {
  await query(
    `insert into halls (id, studio_id, name, capacity, rates, active, photos)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set name=$3, capacity=$4, rates=$5, active=$6, photos=$7
     where halls.studio_id = $2`,
    [item.id, studioId, item.name, item.capacity, JSON.stringify(item.rates), item.active, JSON.stringify(item.photos ?? [])]
  )
}

// Удаление зала: брони остаются (FK ON DELETE SET NULL), дефолтный зал услуг
// отвязывается сам; чистим блокировки времени и упоминания в белых списках.
export async function deleteHall(studioId: string, id: string): Promise<void> {
  await query(`delete from booking_resources where studio_id = $1 and resource_type = 'hall' and resource_id = $2`, [studioId, id])
  await query(
    `update services set hall_ids = (
       select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(hall_ids) x
       where x <> to_jsonb($2::text)
     ) where studio_id = $1 and hall_ids is not null`,
    [studioId, id]
  )
  await query(`delete from halls where id = $1 and studio_id = $2`, [id, studioId])
}

export async function upsertService(studioId: string, item: Service): Promise<void> {
  await query(
    `insert into services
     (id, studio_id, kind, name, description, price_type, price, duration_min, includes,
      deliverable_text, deadline_days, prepayment, needs_specialist, needs_hall,
      default_hall_id, hall_ids, specialist_ids, addon_ids, photo_url, max_people, full_day, multi_day_max, auto_confirm, setup_min, cleanup_min, sort)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     on conflict (id) do update set
       kind=$3, name=$4, description=$5, price_type=$6, price=$7, duration_min=$8,
       includes=$9, deliverable_text=$10, deadline_days=$11, prepayment=$12,
       needs_specialist=$13, needs_hall=$14, default_hall_id=$15, hall_ids=$16, specialist_ids=$17,
       addon_ids=$18, photo_url=$19, max_people=$20, full_day=$21, multi_day_max=$22, auto_confirm=$23, setup_min=$24, cleanup_min=$25, sort=$26
     where services.studio_id = $2`,
    [
      item.id, studioId, item.kind, item.name, item.description, item.priceType,
      item.price, item.durationMin, JSON.stringify(item.includes), item.deliverableText,
      item.deadlineDays, JSON.stringify(item.prepayment), item.needsSpecialist,
      item.needsHall, item.defaultHallId ?? null,
      item.hallIds && item.hallIds.length > 0 ? JSON.stringify(item.hallIds) : null,
      item.specialistIds && item.specialistIds.length > 0 ? JSON.stringify(item.specialistIds) : null,
      item.addonIds ? JSON.stringify(item.addonIds) : null,
      item.photoUrl ?? null,
      item.maxPeople ?? null,
      item.fullDay, item.multiDayMax,
      item.autoConfirm, item.setupMin, item.cleanupMin, item.sort,
    ]
  )
}

// Файлы uploads не в БД: при удалении записи чистим диск best-effort.
async function removeUploadFiles(urls: (string | undefined | null)[]): Promise<void> {
  const prefix = `${config.PUBLIC_BASE_URL}/uploads/`
  for (const u of urls) {
    if (!u || !u.startsWith(prefix)) continue
    const rel = u.slice(prefix.length).split('?')[0]
    try {
      await unlink(`${config.UPLOADS_DIR}/${rel}`)
    } catch {
      // файла уже нет — не страшно
    }
  }
}

export async function deleteService(studioId: string, id: string): Promise<void> {
  const cur = await query(`select photo_url from services where id = $1 and studio_id = $2`, [id, studioId])
  await query(`delete from services where id = $1 and studio_id = $2`, [id, studioId])
  await removeUploadFiles([cur.rows[0]?.photo_url as string | undefined])
}

export async function upsertAddon(studioId: string, item: Addon): Promise<void> {
  await query(
    `insert into addons (id, studio_id, applies_to, name, price, unit, sort)
     values ($1,$2,$3,$4,$5,$6,0)
     on conflict (id) do update set applies_to=$3, name=$4, price=$5, unit=$6
     where addons.studio_id = $2`,
    [item.id, studioId, item.appliesTo, item.name, item.price, item.unit]
  )
}

export async function deleteAddon(studioId: string, id: string): Promise<void> {
  await query(`delete from addons where id = $1 and studio_id = $2`, [id, studioId])
}

export async function upsertPortfolioItem(studioId: string, item: PortfolioItem): Promise<void> {
  await query(
    `insert into portfolio (id, studio_id, category, caption, kind, video_url, src, srcset, sort)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (id) do update set
       category=$3, caption=$4, kind=$5, video_url=$6, src=$7, srcset=$8, sort=$9
     where portfolio.studio_id = $2`,
    [
      item.id, studioId, item.category, item.caption, item.kind,
      item.videoUrl ?? null, item.src, item.srcset ?? null, item.sort,
    ]
  )
}

export async function deletePortfolioItem(studioId: string, id: string): Promise<void> {
  const cur = await query(`select src, srcset from portfolio where id = $1 and studio_id = $2`, [id, studioId])
  await query(`delete from portfolio where id = $1 and studio_id = $2`, [id, studioId])
  const urls: string[] = []
  const src = cur.rows[0]?.src as string | undefined
  if (src) urls.push(src)
  for (const part of ((cur.rows[0]?.srcset as string | undefined) ?? '').split(',')) {
    const u = part.trim().split(' ')[0]
    if (u) urls.push(u)
  }
  await removeUploadFiles(urls)
}

// ---------- закрытые периоды (отпуска специалистов, закрытия залов/студии) ----------

export async function listClosedPeriods(studioId: string): Promise<ClosedPeriod[]> {
  const r = await query<{
    id: string
    resource_type: string | null
    resource_id: string | null
    lo: Date
    hi: Date
    reason: string
  }>(
    `select id, resource_type, resource_id, lower(during) as lo, upper(during) as hi, reason
     from closed_periods where studio_id = $1 order by lower(during)`,
    [studioId]
  )
  const day = (d: Date) => new Date(d).toISOString().slice(0, 10)
  return r.rows.map((row) => ({
    id: row.id,
    resourceType: (row.resource_type as ClosedPeriod['resourceType']) ?? 'studio',
    resourceId: row.resource_id ?? null,
    dateFrom: day(row.lo),
    dateTo: day(row.hi),
    reason: row.reason ?? '',
  }))
}

export interface ClosedPeriodConflict {
  id: string
  serviceName: string
  clientName: string
  startsAtMs: number
}

export async function upsertClosedPeriod(
  studioId: string,
  item: Omit<ClosedPeriod, 'id'> & { id?: string }
): Promise<ClosedPeriod & { conflicts: ClosedPeriodConflict[] }> {
  if (item.resourceType !== 'studio' && !item.resourceId) {
    throw new ApiHttpError(400, 'VALIDATION', 'Для специалиста/зала нужен resourceId')
  }
  const id = item.id ?? randomUUID()
  await query(
    `insert into closed_periods (id, studio_id, resource_type, resource_id, during, reason)
     values ($1, $2, $3, $4, tstzrange(($5)::timestamptz, ($6)::timestamptz, '[)'), $7)
     on conflict (id) do update set resource_type=$3, resource_id=$4, during=tstzrange(($5)::timestamptz, ($6)::timestamptz, '[)'), reason=$7`,
    [
      id,
      studioId,
      item.resourceType === 'studio' ? null : item.resourceType,
      item.resourceType === 'studio' ? null : item.resourceId,
      `${item.dateFrom}T00:00:00Z`,
      `${item.dateTo}T23:59:59Z`,
      item.reason ?? '',
    ]
  )
  // Активные заявки, пересекающиеся с новым периодом: владелец должен видеть,
  // чьи съёмки он закрывает. booking_resources не трогаем — заявка могла быть
  // создана без блокировок; пересечение считаем по starts_at/ends_at брони.
  const params: unknown[] = [
    studioId,
    new Date(`${item.dateTo}T23:59:59Z`),
    new Date(`${item.dateFrom}T00:00:00Z`),
    ['new', 'confirmed', 'prepaid', 'shot_done', 'processing', 'delivered'],
  ]
  let scope = ''
  if ((item.resourceType === 'specialist' || item.resourceType === 'hall') && item.resourceId) {
    params.push(item.resourceId)
    const col = item.resourceType === 'specialist' ? 'specialist_id' : 'hall_id'
    scope = ` and b.${col} = $${params.length}`
  }
  const r = await query<{ id: string; service_name: string; client: { name?: string } | null; starts_at: Date }>(
    `select b.id, b.service_name, b.client, b.starts_at from bookings b
     where b.studio_id = $1 and b.status = any($4)
       and b.starts_at < $2 and b.ends_at > $3${scope}
     order by b.starts_at`,
    params
  )
  const conflicts: ClosedPeriodConflict[] = r.rows.map((row) => ({
    id: row.id,
    serviceName: row.service_name ?? '',
    clientName: row.client?.name ?? '',
    startsAtMs: new Date(row.starts_at).getTime(),
  }))
  return { ...item, id, conflicts }
}

export async function deleteClosedPeriod(studioId: string, id: string): Promise<void> {
  await query(`delete from closed_periods where id = $1 and studio_id = $2`, [id, studioId])
}

export async function saveSettings(studioId: string, settings: StudioBundle['settings']): Promise<void> {
  await query(`update studios set settings = $2, updated_at = now() where id = $1`, [
    studioId,
    JSON.stringify(settings),
  ])
}

// Для статистики/списков: заявки студии уже через bookings-сервис; тип-хелпер не нужен.
export type { BookingRecord }
