// §9: миграция данных Supabase → новая БД.
// SOURCE_DATABASE_URL → DATABASE_URL, вся копия в одной транзакции,
// в конце — сверка количества строк.
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { pool } from '../src/db'

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')

const sourceUrl = process.env.SOURCE_DATABASE_URL
const targetUrl = process.env.DATABASE_URL
if (!sourceUrl || !targetUrl) {
  console.error('Нужны SOURCE_DATABASE_URL и DATABASE_URL')
  process.exit(1)
}

interface Count { table: string; source: number; target: number }
const counts: Count[] = []

async function copyTable(
  s: Client,
  t: Client,
  name: string,
  selectSql: string,
  insertSql: string,
  rowMapper: (row: Record<string, unknown>) => unknown[],
  filter?: (row: Record<string, unknown>) => boolean
): Promise<number> {
  const src = await s.query(selectSql)
  const rows = src.rows.filter((r) => (filter ? filter(r) : true))
  for (const row of rows) {
    const values = rowMapper(row)
    const placeholders = values.map((_, i) => `$${i + 1}`).join(',')
    await t.query(insertSql.replace('%P%', placeholders), values)
  }
  return rows.length
}

async function main() {
  const s = new Client({ connectionString: sourceUrl })
  const t = new Client({ connectionString: targetUrl })
  await s.connect()
  await t.connect()

  try {
    await t.query('begin')

    // users: bcrypt-хеш переносится как есть (логин перехеширует в Argon2id, §5.1)
    counts.push({
      table: 'users',
      source: (await s.query(`select count(*)::int n from auth.users`)).rows[0].n,
      target: 0,
    })
    const users = await s.query(
      `select id, email, encrypted_password from auth.users where email is not null`
    )
    for (const u of users.rows) {
      await t.query(
        `insert into users (id, email, password_hash) values ($1, $2, $3)
         on conflict (email) do nothing`,
        [u.id, u.email, u.encrypted_password]
      )
    }

    counts.push({
      table: 'studios',
      source: (await s.query(`select count(*)::int n from public.studios`)).rows[0].n,
      target: 0,
    })
    const studios = await s.query(
      `select id, slug, settings, status, "calendarToken" from public.studios`
    )
    for (const st of studios.rows) {
      await t.query(
        `insert into studios (id, slug, settings, status, calendar_token)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do update set settings = $3, calendar_token = $5`,
        [st.id, st.slug, JSON.stringify(st.settings), st.status, st.calendarToken]
      )
    }

    // Сначала обе стороны FK, затем членство. Не повышаем незнакомую роль.
    const memberships = await s.query(`select "userId", "studioId", role from public.memberships`)
    counts.push({ table: 'memberships', source: memberships.rows.length, target: 0 })
    for (const m of memberships.rows) {
      if (!['owner', 'manager', 'employee'].includes(m.role)) throw new Error('Неизвестная роль в исходной базе')
      await t.query(
        `insert into memberships (user_id, studio_id, role) values ($1, $2, $3)
         on conflict (user_id, studio_id) do nothing`,
        [m.userId, m.studioId, m.role]
      )
    }

    const simpleTables: [string, string, string[], (r: Record<string, unknown>) => unknown[]][] = [
      ['specialists', `select * from public.specialists`, ['id', 'studio_id', 'name', 'title', 'active', 'day_limit'],
        (r) => [r.id, r.studioId ?? r['studio_id'], r.name, r.title, r.active, r.dayLimit]],
      ['halls', `select * from public.halls`, ['id', 'studio_id', 'name', 'capacity', 'rates', 'active'],
        (r) => [r.id, r.studioId ?? r['studio_id'], r.name, r.capacity, JSON.stringify(r.rates), r.active]],
      ['addons', `select * from public.addons`, ['id', 'studio_id', 'applies_to', 'name', 'price', 'unit', 'sort'],
        (r) => [r.id, r.studioId ?? r['studio_id'], r.appliesTo ?? r['applies_to'], r.name, r.price, r.unit, r.sort ?? 0]],
    ]
    // services/portfolio копируются отдельными блоками (больше колонок)

    for (const [table, selectSql, cols, mapper] of simpleTables) {
      counts.push({ table, source: (await s.query(`select count(*)::int n from public.${table}`)).rows[0].n, target: 0 })
      const rows = await s.query(selectSql)
      for (const row of rows.rows) {
        const values = mapper(row)
        await t.query(
          `insert into ${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})
            on conflict (studio_id, id) do nothing`,
          values
        )
      }
    }

    counts.push({ table: 'services', source: (await s.query(`select count(*)::int n from public.services`)).rows[0].n, target: 0 })
    const services = await s.query(`select * from public.services`)
    for (const r of services.rows) {
      await t.query(
        `insert into services (id, studio_id, kind, name, description, price_type, price, duration_min,
         includes, deliverable_text, deadline_days, prepayment, needs_specialist, needs_hall,
         default_hall_id, full_day, multi_day_max, auto_confirm, setup_min, cleanup_min, sort)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
          on conflict (studio_id, id) do nothing`,
        [
          r.id, r.studioId, r.kind, r.name, r.description, r.priceType, r.price, r.durationMin,
          JSON.stringify(r.includes), r.deliverableText, r.deadlineDays, JSON.stringify(r.prepayment),
          r.needsSpecialist, r.needsHall, r.defaultHallId ?? null, r.fullDay, r.multiDayMax,
          r.autoConfirm, r.setupMin, r.cleanupMin, r.sort,
        ]
      )
    }

    counts.push({ table: 'portfolio', source: (await s.query(`select count(*)::int n from public.portfolio`)).rows[0].n, target: 0 })
    const portfolio = await s.query(`select * from public.portfolio`)
    for (const r of portfolio.rows) {
      await t.query(
        `insert into portfolio (id, studio_id, category, caption, kind, video_url, src, srcset, sort)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (studio_id, id) do nothing`,
        [r.id, r.studioId, r.category, r.caption, r.kind, r.videoUrl ?? null, r.src, r.srcset ?? null, r.sort]
      )
    }

    counts.push({ table: 'bookings', source: (await s.query(`select count(*)::int n from public.bookings`)).rows[0].n, target: 0 })
    const bookings = await s.query(`select * from public.bookings`)
    for (const r of bookings.rows) {
      // §9: access_token → sha256 — старые ссылки клиентов продолжают работать
      await t.query(
        `insert into bookings (id, studio_id, kind, service_id, service_name, specialist_id, hall_id,
         starts_at, ends_at, all_day, day_count, status, client, "references", price, paid_total,
         deliverables_url, access_token_hash, idempotency_key, source, offsite, travel_zone_id,
         consent, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         on conflict (id) do nothing`,
        [
          r.id, r.studioId, r.kind, r.serviceId ?? null, r.serviceName ?? '',
          r.specialistId ?? null, r.hallId ?? null,
          r.startsAt, r.endsAt, r.allDay ?? false, r.dayCount ?? 1, r.status,
           JSON.stringify(r.client), JSON.stringify(r.references ?? []), JSON.stringify(r.price),
          r.paidTotal ?? 0, r.deliverablesUrl ?? null,
          sha256(r.accessToken), r.idempotencyKey ?? null, r.source ?? 'web',
          r.offsite ?? false, r.travelZoneId ?? null, JSON.stringify(r.consent ?? {}), r.createdAt,
        ]
      )
    }

    counts.push({ table: 'booking_resources', source: (await s.query(`select count(*)::int n from public.booking_resources`)).rows[0].n, target: 0 })
    const brs = await s.query(`select * from public.booking_resources`)
    for (const r of brs.rows) {
      await t.query(
        `insert into booking_resources (id, booking_id, studio_id, resource_type, resource_id, during)
         values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing`,
        [r.id, r.bookingId, r.studioId, r.resourceType, r.resourceId, r.during]
      )
    }

    for (const table of ['closed_periods', 'assistant_usage']) {
      counts.push({ table, source: (await s.query(`select count(*)::int n from public.${table}`)).rows[0].n, target: 0 })
      const rows = await s.query(`select * from public.${table}`)
      for (const r of rows.rows) {
        const cols = Object.keys(r).map(camelToSnake)
        const values = Object.keys(r).map((k) => r[k])
        await t.query(
          `insert into ${table} (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})
           on conflict do nothing`,
          values
        )
      }
    }

    // Старые подписки не привязаны к записи. Клиенты включат напоминания снова;
    // старую очередь не отправляем повторно с новыми правилами получателей.

    await t.query('commit')

    console.log('\nСверка количеств:')
    for (const c of counts) {
      const check = await t.query(`select count(*)::int n from ${c.table.split('(')[0]}`)
      c.target = check.rows[0].n
      const mark = c.source === c.target ? '✓' : '~'
      console.log(`${mark} ${c.table}: source=${c.source} target=${c.target}`)
    }
    console.log('\nГотово. Проверьте вручную: старые ссылки /s/<slug>/my/<token>, вход старых владельцев.')
  } catch (e) {
    await t.query('rollback')
    throw e
  } finally {
    await s.end()
    await t.end()
    await pool.end().catch(() => {})
  }
}

function camelToSnake(k: string): string {
  return k.replace(/[A-Z]/g, (ch) => '_' + ch.toLowerCase())
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
