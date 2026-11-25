// Порт tenant-push.ts: залить tenants/<slug>/tenant.json в новую БД.
// Существующую студию не перезаписывает без --force (правки владельца защищены).
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { validateTenantConfig } from '../../src/core/schema'
import { pool, query, tx } from '../src/db'

const slugArg = process.argv.find((a) => a.startsWith('--slug='))?.split('=')[1]
const force = process.argv.includes('--force')

if (!slugArg || !/^[a-z0-9-]{2,40}$/.test(slugArg)) {
  console.error('Использование: pnpm studio:create --slug=kadr-studio [--force]')
  process.exit(1)
}

const cfgPath = path.resolve(__dirname, '../../tenants', slugArg, 'tenant.json')
if (!existsSync(cfgPath)) {
  console.error(`Не найден ${cfgPath}`)
  process.exit(1)
}
const cfg = validateTenantConfig(JSON.parse(readFileSync(cfgPath, 'utf8')))

async function main() {
  const existing = await query<{ id: string; status: string }>(`select id, status from studios where slug = $1`, [slugArg])
  if (existing.rows.length > 0 && !force) {
    console.log(`⏭ ${slugArg}: уже в базе, пропущен (--force для перезаписи)`)
    await pool.end()
    return
  }

  const studioId = existing.rows[0]?.id ?? slugArg
  const settings = { ...cfg.settings, slug: slugArg, status: existing.rows[0]?.status ?? cfg.settings.status }
  await tx(async (c) => {
    await c.query(
      `insert into studios (id, slug, settings, status) values ($1, $2, $3, $4)
       on conflict (slug) do update set settings = $3, updated_at = now()
       where studios.id = $1`,
      [studioId, slugArg, JSON.stringify(settings), settings.status]
    )
    const tables: [string, unknown[][]][] = [
      [
        'specialists',
        cfg.specialists.map((x) => [
          x.id, slugArg, x.name, x.title, x.active, x.dayLimit,
          // C5: поля, добавленные миграциями 0002/0003/0008/0010
          x.photoUrl ?? null,
          x.showOnTeam ?? true,
          x.schedule ? JSON.stringify(x.schedule) : null,
          x.hourRate ?? null,
        ]),
      ],
      [
        'halls',
        cfg.halls.map((x) => [
          x.id, slugArg, x.name, x.capacity, JSON.stringify(x.rates), x.active,
          // C5: фото залов (миграция 0004)
          JSON.stringify(x.photos ?? []),
        ]),
      ],
      [
        'services',
        cfg.services.map((x) => [
          x.id, slugArg, x.kind, x.name, x.description, x.priceType, x.price,
          x.durationMin, JSON.stringify(x.includes), x.deliverableText, x.deadlineDays,
          JSON.stringify(x.prepayment), x.needsSpecialist, x.needsHall,
          x.defaultHallId ?? null,
          x.hallIds && x.hallIds.length > 0 ? JSON.stringify(x.hallIds) : null, // C5: белый список залов (0004)
          x.fullDay, x.multiDayMax, x.autoConfirm,
          x.setupMin, x.cleanupMin, x.sort,
          x.photoUrl ?? null, // C5: обложка услуги (0005)
          x.maxPeople ?? null,
          x.addonIds ? JSON.stringify(x.addonIds) : null,
          x.referencesEnabled ?? null,
          x.specialistIds ? JSON.stringify(x.specialistIds) : null,
          x.allSpecialistsRequired ?? false,
        ]),
      ],
      [
        'addons',
        cfg.addons.map((x) => [
          x.id, slugArg, x.appliesTo, x.name, x.price, x.unit, 0,
          x.hallIds ? JSON.stringify(x.hallIds) : null,
        ]),
      ],
      [
        'portfolio',
        cfg.portfolio.map((x) => [x.id, slugArg, x.category, x.caption, x.kind, x.videoUrl ?? null, x.src, x.srcset ?? null, x.sort]),
      ],
    ]
    for (const [table, rows] of tables) {
      // Сидинг обновляет указанные строки, не удаляя каталог с историей броней.
      const names = columns(table)
      const assignments = names.split(', ').map((name) => `${name} = excluded.${name}`).join(', ')
      for (const row of rows) {
        const placeholders = row.slice(2).map((_, i) => `$${i + 3}`).join(',')
        await c.query(
          `insert into ${table} (id, studio_id, ${names}) values ($1, $2, ${placeholders})
           on conflict (studio_id, id) do update set ${assignments}`,
          [row[0], studioId, ...row.slice(2)]
        )
      }
    }
  })

  console.log(`✓ ${slugArg} залит (status=${settings.status})`)
  await pool.end()
}

function columns(table: string): string {
  switch (table) {
    case 'specialists': return 'name, title, active, day_limit, photo_url, show_on_team, schedule, hour_rate'
    case 'halls': return 'name, capacity, rates, active, photos'
    case 'services': return 'kind, name, description, price_type, price, duration_min, includes, deliverable_text, deadline_days, prepayment, needs_specialist, needs_hall, default_hall_id, hall_ids, full_day, multi_day_max, auto_confirm, setup_min, cleanup_min, sort, photo_url, max_people, addon_ids, references_enabled, specialist_ids, all_specialists_required'
    case 'addons': return 'applies_to, name, price, unit, sort, hall_ids'
    case 'portfolio': return 'category, caption, kind, video_url, src, srcset, sort'
    default: throw new Error(table)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
