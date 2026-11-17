// Порт tenant-push.ts: залить tenants/<slug>/tenant.json в новую БД.
// Существующую студию не перезаписывает без --force (правки владельца защищены).
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { validateTenantConfig } from '../../src/core/schema'
import { pool, query, tx } from '../src/db'

const slugArg = process.argv.find((a) => a.startsWith('--slug='))?.split('=')[1]
const force = process.argv.includes('--force')

if (!slugArg) {
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
  const existing = await query(`select 1 from studios where slug = $1`, [slugArg])
  if (existing.rows.length > 0 && !force) {
    console.log(`⏭ ${slugArg}: уже в базе, пропущен (--force для перезаписи)`)
    await pool.end()
    return
  }

  await tx(async (c) => {
    await c.query(
      `insert into studios (id, slug, settings, status) values ($1, $2, $3, $4)
       on conflict (id) do update set settings = $3, status = $4, updated_at = now()`,
      [slugArg, slugArg, JSON.stringify(cfg.settings), cfg.settings.status]
    )
    const tables: [string, unknown[][]][] = [
      [
        'specialists',
        cfg.specialists.map((x) => [x.id, slugArg, x.name, x.title, x.active, x.dayLimit]),
      ],
      [
        'halls',
        cfg.halls.map((x) => [x.id, slugArg, x.name, x.capacity, JSON.stringify(x.rates), x.active]),
      ],
      [
        'services',
        cfg.services.map((x) => [
          x.id, slugArg, x.kind, x.name, x.description, x.priceType, x.price,
          x.durationMin, JSON.stringify(x.includes), x.deliverableText, x.deadlineDays,
          JSON.stringify(x.prepayment), x.needsSpecialist, x.needsHall,
          x.defaultHallId ?? null, x.fullDay, x.multiDayMax, x.autoConfirm,
          x.setupMin, x.cleanupMin, x.sort,
        ]),
      ],
      [
        'addons',
        cfg.addons.map((x) => [x.id, slugArg, x.appliesTo, x.name, x.price, x.unit, 0]),
      ],
      [
        'portfolio',
        cfg.portfolio.map((x) => [x.id, slugArg, x.category, x.caption, x.kind, x.videoUrl ?? null, x.src, x.srcset ?? null, x.sort]),
      ],
    ]
    for (const [table, rows] of tables) {
      await c.query(`delete from ${table} where studio_id = $1`, [slugArg])
      for (const row of rows) {
        const placeholders = row.slice(2).map((_, i) => `$${i + 3}`).join(',')
        await c.query(`insert into ${table} (id, studio_id, ${columns(table)}) values ($1, $2, ${placeholders})`, [row[0], row[1], ...row.slice(2)])
      }
    }
  })

  console.log(`✓ ${slugArg} залит (status=${cfg.settings.status})`)
  await pool.end()
}

function columns(table: string): string {
  switch (table) {
    case 'specialists': return 'name, title, active, day_limit'
    case 'halls': return 'name, capacity, rates, active'
    case 'services': return 'kind, name, description, price_type, price, duration_min, includes, deliverable_text, deadline_days, prepayment, needs_specialist, needs_hall, default_hall_id, full_day, multi_day_max, auto_confirm, setup_min, cleanup_min, sort'
    case 'addons': return 'applies_to, name, price, unit, sort'
    case 'portfolio': return 'category, caption, kind, video_url, src, srcset, sort'
    default: throw new Error(table)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
