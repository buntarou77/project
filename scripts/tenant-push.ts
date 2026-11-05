import fs from 'node:fs'
import path from 'node:path'
import { validateTenantConfig } from '../src/core/schema'

// Заливает tenant.json в Supabase через REST (service role).
// По умолчанию НЕ перезаписывает существующую студию — правки владельца защищены.
// Перезаписать явно: pnpm tenant:push --slug=X --force
// Env: SUPABASE_URL (или VITE_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY

const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const force = process.argv.includes('--force')
const slugArg = process.argv.find((a) => a.startsWith('--slug='))?.split('=')[1]

function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

if (!url || !key) die('Нужны переменные окружения SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY (см. .env.example)')

async function rest(table: string, method: string, body?: unknown, query = ''): Promise<unknown> {
  const res = await fetch(`${url}/rest/v1/${table}${query}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) die(`${table}: ${res.status} ${await res.text()}`)
  return res.json()
}

for (const slug of fs.readdirSync('tenants')) {
  if (slugArg && slug !== slugArg) continue
  const cfgPath = path.join('tenants', slug, 'tenant.json')
  if (!fs.existsSync(cfgPath)) continue
  const cfg = validateTenantConfig(JSON.parse(fs.readFileSync(cfgPath, 'utf8')))

  const existing = (await rest('studios', 'GET', undefined, `?slug=eq.${slug}&select=id`)) as unknown[]
  if (existing.length > 0 && !force) {
    console.log(`⏭ ${slug}: уже в базе, пропущен (правки владельца не тронуты; для перезаписи добавьте --force)`)
    continue
  }

  await rest('studios', 'POST', {
    id: slug,
    slug,
    settings: cfg.settings,
    status: cfg.settings.status,
  })

  const tables: Record<string, unknown[]> = {
    specialists: cfg.specialists.map((x) => ({ ...x, studioId: slug })),
    halls: cfg.halls.map((x) => ({ ...x, studioId: slug })),
    services: cfg.services.map((x) => ({ ...x, studioId: slug })),
    addons: cfg.addons.map((x) => ({ ...x, studioId: slug })),
    portfolio: cfg.portfolio.map((x) => ({ ...x, studioId: slug })),
  }
  for (const [table, rows] of Object.entries(tables)) {
    if (rows.length) await rest(table, 'POST', rows)
  }

  // демо-брони (занятое время для образца)
  for (const seed of cfg.seedBookings) {
    const service = cfg.services[0]
    await rest('bookings', 'POST', {
      studioId: slug,
      slug,
      kind: service?.kind ?? 'shoot',
      serviceId: service?.id ?? 'svc-portrait',
      serviceName: seed.summary,
      startsAt: seed.startsAt,
      endsAt: seed.endsAt,
      status: 'confirmed',
      client: { name: 'Демо-занятость', phone: '—', method: 'phone' },
      price: { lines: [], total: 0, prepayment: 0 },
      source: 'manual',
      idempotencyKey: `seed-${slug}-${seed.startsAt}`,
      consent: { version: 'seed', at: seed.startsAt, accepted: true },
      references: [],
    })
  }

  console.log(`✓ ${slug} залит в базу (${url})`)
}
