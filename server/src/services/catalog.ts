import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { query } from '../db'
import { buildBundle, mapAddon, mapHall, mapPortfolio, mapService, mapSpecialist, mapStudio } from '../mapping'
import type { BookingRecord, StudioBundle } from '../../../src/backend/types'
import type { Addon, ClosedPeriod, Hall, PortfolioItem, Service, Specialist } from '../../../src/core/types'
import { zonedToUtcMs, addDaysToDateString } from '../../../src/core/time'
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
  // D9: старое фото (если менялось) — удалить с диска
  const prev = await query<{ photo_url: string | null }>(
    `select photo_url from specialists where studio_id = $1 and id = $2`,
    [studioId, item.id]
  )
  const prevUrl = prev.rows[0]?.photo_url ?? null
  await query(
    `insert into specialists (id, studio_id, name, title, active, day_limit, photo_url, show_on_team, schedule, hour_rate)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (studio_id, id) do update set name=$3, title=$4, active=$5, day_limit=$6, photo_url=$7, show_on_team=$8, schedule=$9, hour_rate=$10`,
    [item.id, studioId, item.name, item.title, item.active, item.dayLimit, item.photoUrl ?? null, item.showOnTeam ?? true, item.schedule ? JSON.stringify(item.schedule) : null, item.hourRate ?? null]
  )
  if (prevUrl && prevUrl !== (item.photoUrl ?? null)) await removeUploadFiles([prevUrl], studioId)
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
  // удалили последнего участника команды — снимаем режим, иначе услуга
  // останется с «командой» из нуля человек
  await query(
    `update services set all_specialists_required = false
     where studio_id = $1 and all_specialists_required
       and (specialist_ids is null or specialist_ids = '[]'::jsonb)`,
    [studioId]
  )
  await query(`delete from specialists where id = $1 and studio_id = $2`, [id, studioId])
}

export async function upsertHall(studioId: string, item: Hall): Promise<void> {
  // D9: фото, убранные из галереи, — удалить с диска
  const prev = await query<{ photos: string[] | null }>(
    `select photos from halls where studio_id = $1 and id = $2`,
    [studioId, item.id]
  )
  const prevPhotos = prev.rows[0]?.photos ?? []
  const nextSet = new Set(item.photos ?? [])
  const gone = prevPhotos.filter((u) => !nextSet.has(u))
  await query(
    `insert into halls (id, studio_id, name, capacity, rates, active, photos)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (studio_id, id) do update set name=$3, capacity=$4, rates=$5, active=$6, photos=$7`,
    [item.id, studioId, item.name, item.capacity, JSON.stringify(item.rates), item.active, JSON.stringify(item.photos ?? [])]
  )
  if (gone.length) await removeUploadFiles(gone, studioId)
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
  // D9: старая обложка (если менялась) — удалить с диска
  const prev = await query<{ photo_url: string | null }>(
    `select photo_url from services where studio_id = $1 and id = $2`,
    [studioId, item.id]
  )
  const prevUrl = prev.rows[0]?.photo_url ?? null
  await query(
    `insert into services
     (id, studio_id, kind, name, description, price_type, price, duration_min, includes,
      deliverable_text, deadline_days, prepayment, needs_specialist, needs_hall,
      default_hall_id, hall_ids, specialist_ids, addon_ids, photo_url, max_people, full_day, multi_day_max, auto_confirm, setup_min, cleanup_min, sort, references_enabled,
      all_specialists_required)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
     on conflict (studio_id, id) do update set
       kind=$3, name=$4, description=$5, price_type=$6, price=$7, duration_min=$8,
       includes=$9, deliverable_text=$10, deadline_days=$11, prepayment=$12,
       needs_specialist=$13, needs_hall=$14, default_hall_id=$15, hall_ids=$16, specialist_ids=$17,
       addon_ids=$18, photo_url=$19, max_people=$20, full_day=$21, multi_day_max=$22, auto_confirm=$23, setup_min=$24, cleanup_min=$25, sort=$26,
       references_enabled=$27, all_specialists_required=$28`,
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
      item.referencesEnabled ?? null,
      item.allSpecialistsRequired ?? false,
    ]
  )
  if (prevUrl && prevUrl !== (item.photoUrl ?? null)) await removeUploadFiles([prevUrl], studioId)
}

// Файлы uploads не в БД: при удалении записи чистим диск best-effort.
async function removeUploadFiles(urls: (string | undefined | null)[], studioId: string): Promise<void> {
  // URL хранится в каталоге строкой, и её мог прислать владелец: удаляем только
  // файл СВОЕГО каталога студии и только внутри UPLOADS_DIR — иначе «..» в URL
  // выводил unlink на чужие и системные файлы
  const base = path.resolve(config.UPLOADS_DIR)
  const own = `${config.PUBLIC_BASE_URL}/uploads/${studioId}/`
  for (const u of urls) {
    if (!u || !u.startsWith(own)) continue
    const rel = u.slice(own.length).split('?')[0]
    const abs = path.resolve(config.UPLOADS_DIR, studioId, rel)
    if (!abs.startsWith(base + path.sep)) continue
    try {
      await unlink(abs)
    } catch {
      // файла уже нет — не страшно
    }
  }
}

export async function deleteService(studioId: string, id: string): Promise<void> {
  const cur = await query(`select photo_url from services where id = $1 and studio_id = $2`, [id, studioId])
  await query(`delete from services where id = $1 and studio_id = $2`, [id, studioId])
  await removeUploadFiles([cur.rows[0]?.photo_url as string | undefined], studioId)
}

export async function upsertAddon(studioId: string, item: Addon): Promise<void> {
  await query(
    `insert into addons (id, studio_id, applies_to, name, price, unit, sort, hall_ids)
     values ($1,$2,$3,$4,$5,$6,0,$7)
     on conflict (studio_id, id) do update set applies_to=$3, name=$4, price=$5, unit=$6, hall_ids=$7`,
    [item.id, studioId, item.appliesTo, item.name, item.price, item.unit, item.hallIds && item.hallIds.length > 0 ? JSON.stringify(item.hallIds) : null]
  )
}

export async function deleteAddon(studioId: string, id: string): Promise<void> {
  await query(`delete from addons where id = $1 and studio_id = $2`, [id, studioId])
}

export async function upsertPortfolioItem(studioId: string, item: PortfolioItem): Promise<void> {
  // D9: заменённые файлы работы (src/srcset) — удалить с диска
  const prev = await query<{ src: string | null; srcset: string | null }>(
    `select src, srcset from portfolio where studio_id = $1 and id = $2`,
    [studioId, item.id]
  )
  const prevUrls: string[] = []
  if (prev.rows[0]?.src) prevUrls.push(prev.rows[0].src)
  for (const part of (prev.rows[0]?.srcset ?? '').split(',')) {
    const u = part.trim().split(' ')[0]
    if (u) prevUrls.push(u)
  }
  const nextUrls = new Set([item.src])
  for (const part of (item.srcset ?? '').split(',')) {
    const u = part.trim().split(' ')[0]
    if (u) nextUrls.add(u)
  }
  const gone = prevUrls.filter((u) => !nextUrls.has(u))
  await query(
    `insert into portfolio (id, studio_id, category, caption, kind, video_url, src, srcset, sort)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (studio_id, id) do update set
       category=$3, caption=$4, kind=$5, video_url=$6, src=$7, srcset=$8, sort=$9`,
    [
      item.id, studioId, item.category, item.caption, item.kind,
      item.videoUrl ?? null, item.src, item.srcset ?? null, item.sort,
    ]
  )
  if (gone.length) await removeUploadFiles(gone, studioId)
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
  // B-70: видео использует фото первой карточки как постер: файл удаляем,
  // только если на него больше никто не ссылается
  const stillUsed = await query<{ n: number }>(
    `select count(*)::int n from portfolio where studio_id = $1 and src = $2 and id <> $3`,
    [studioId, src ?? '', id]
  )
  if (stillUsed.rows[0].n === 0) await removeUploadFiles(urls, studioId)
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
  item: Omit<ClosedPeriod, 'id'> & { id?: string },
  tz: string
): Promise<ClosedPeriod & { conflicts: ClosedPeriodConflict[] }> {
  if (item.resourceType !== 'studio' && !item.resourceId) {
    throw new ApiHttpError(400, 'VALIDATION', 'Для специалиста/зала нужен resourceId')
  }
  // B3: перевёрнутый диапазон — 400, а не 500 от tstzrange
  if (item.dateTo < item.dateFrom) {
    throw new ApiHttpError(400, 'VALIDATION', 'Дата «по» не может быть раньше даты «с»')
  }
  const id = item.id ?? randomUUID()
  // Границы — в таймзоне студии, интервал полуоткрытый [открытие; полуночь
  // следующего дня). В UTC закрытый день для UTC+3 был сдвинут на три часа:
  // первые три часа закрытого дня оставались доступными.
  const fromMs = zonedToUtcMs(tz, item.dateFrom, '00:00')
  const toMs = zonedToUtcMs(tz, addDaysToDateString(item.dateTo, 1), '00:00')
  await query(
    `insert into closed_periods (id, studio_id, resource_type, resource_id, during, reason)
     values ($1, $2, $3, $4, tstzrange($5, $6, '[)'), $7)
     on conflict (studio_id, id) do update set resource_type=$3, resource_id=$4, during=tstzrange($5, $6, '[)'), reason=$7`,
    [
      id,
      studioId,
      item.resourceType === 'studio' ? null : item.resourceType,
      item.resourceType === 'studio' ? null : item.resourceId,
      new Date(fromMs),
      new Date(toMs),
      item.reason ?? '',
    ]
  )
  // Активные заявки, пересекающиеся с новым периодом: владелец должен видеть,
  // чьи съёмки он закрывает. booking_resources не трогаем — заявка могла быть
  // создана без блокировок; пересечение считаем по starts_at/ends_at брони.
  const params: unknown[] = [
    studioId,
    new Date(toMs),
    new Date(fromMs),
    ['new', 'confirmed', 'prepaid', 'shot_done', 'processing', 'delivered'],
  ]
  let scope = ''
  if ((item.resourceType === 'specialist' || item.resourceType === 'hall') && item.resourceId) {
    params.push(item.resourceId)
    scope = item.resourceType === 'specialist'
      ? ` and (b.specialist_id = $${params.length} or coalesce(b.specialist_ids, '[]'::jsonb) @> to_jsonb($${params.length}::text))`
      : ` and b.hall_id = $${params.length}`
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
  // D9: заменённое или убранное своё фото hero — удалить с диска. Только файл
  // из своего каталога hero: внешние URL и чужие каталоги не трогаем
  const prev = await query<{ settings: { heroPhotoUrl?: string | null } }>(`select settings from studios where id = $1`, [
    studioId,
  ])
  await query(`update studios set settings = $2, updated_at = now() where id = $1`, [
    studioId,
    JSON.stringify(settings),
  ])
  const prevHero = prev.rows[0]?.settings?.heroPhotoUrl
  const heroPrefix = `${config.PUBLIC_BASE_URL}/uploads/${studioId}/hero/`
  if (prevHero && prevHero.startsWith(heroPrefix) && prevHero !== settings.heroPhotoUrl) {
    await removeUploadFiles([prevHero], studioId)
  }
}

// Для статистики/списков: заявки студии уже через bookings-сервис; тип-хелпер не нужен.
export type { BookingRecord }
