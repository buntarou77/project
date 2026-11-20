// Y-регрессии: notify reclaim/cleanup на реальном Postgres.
// Файл запускается после api.test.ts (fileParallelism: false); api удаляет
// автоматический TEST_DATABASE_URL, поэтому здесь поднимается свежий embedded PG.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

let embeddedPg: { stop: () => Promise<void> } | null = null
if (!process.env.TEST_DATABASE_URL) {
  const { default: EmbeddedPostgres } = await import('embedded-postgres')
  embeddedPg = new EmbeddedPostgres({
    databaseDir: path.resolve(__dirname, '.pgdata'),
    user: 'postgres',
    password: 'test',
    port: 5433,
    persistent: false,
  })
  await embeddedPg.initialise()
  await embeddedPg.start()
  await embeddedPg.createDatabase('photo_booking_test')
  process.env.TEST_DATABASE_URL = 'postgres://postgres:test@localhost:5433/photo_booking_test'
}

const TEST_DB = process.env.TEST_DATABASE_URL
const d = TEST_DB ? describe : describe.skip

let pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<void> }

d('Y-регрессии', () => {
  beforeAll(async () => {
    // Z5: без JWT_SECRET config.ts зовёт process.exit(1) — файл падал на импорте,
    // оба P4-теста молча пропускались (проверено прогоном 19.11: 1 failed | 1 passed)
    process.env.DATABASE_URL = TEST_DB
    process.env.JWT_SECRET = 'test-secret-test-secret-test-secret!'
    process.env.NODE_ENV = 'test'
    process.env.UPLOADS_DIR = './uploads-test'
    process.env.DISABLE_WORKER = '1'
    const { pool: p } = await import('../src/db')
    pool = p
    await pool.query(`drop schema if exists public cascade; create schema public;`)
    const dir = path.resolve(__dirname, '../migrations')
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await pool.query(readFileSync(path.join(dir, f), 'utf8'))
    }
  })

  afterAll(async () => {
    try {
      await pool?.end()
    } finally {
      if (embeddedPg) {
        try {
          await embeddedPg.stop()
        } catch (e) {
          console.warn('embedded pg stop:', e instanceof Error ? e.message : e)
        }
        delete process.env.TEST_DATABASE_URL
      }
    }
  })

  it('P4: reclaim возвращает только зависшие processing, свежие не трогает', async () => {
    await pool.query(`insert into studios (id, slug, settings) values ('reg-studio','reg-studio','{}')`)
    await pool.query(
      `insert into notify_outbox (id, studio_id, channel, payload, status, claimed_at)
       values ('stuck', 'reg-studio', 'email', '{}', 'processing', now() - interval '10 minutes'),
              ('fresh', 'reg-studio', 'email', '{}', 'processing', now())`
    )
    const { reclaimStuckNotifications } = await import('../src/services/notify')
    const n = await reclaimStuckNotifications(300)
    expect(n).toBe(1)
    const rows = await pool.query(
      `select id, status, claimed_at from notify_outbox order by id`
    )
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]))
    expect(byId.fresh.status).toBe('processing')
    expect(byId.fresh.claimed_at).toBeTruthy()
    expect(byId.stuck.status).toBe('pending')
    expect(byId.stuck.claimed_at).toBeNull()
  })

  it('P4: cleanup удаляет старые processed/failed только в ночное окно UTC', async () => {
    await pool.query(
      `insert into notify_outbox (id, studio_id, channel, payload, status, processed_at)
       values ('old-done', 'reg-studio', 'email', '{}', 'processed', now() - interval '8 days'),
              ('fresh-done', 'reg-studio', 'email', '{}', 'processed', now() - interval '1 day')`
    )
    const { cleanupNotificationData } = await import('../src/services/notify')
    const spy = vi.spyOn(Date.prototype, 'getUTCHours').mockReturnValue(4)
    await cleanupNotificationData()
    expect(spy).toHaveBeenCalled()
    const rows = await pool.query(`select id from notify_outbox where id in ('old-done','fresh-done') order by id`)
    expect(rows.rows.map((r) => r.id)).toEqual(['fresh-done'])
    vi.restoreAllMocks()
  })

  it('Z4: анонимизация сбрасывает client.referenceCount', async () => {
    await pool.query(
      `insert into bookings (id, studio_id, kind, starts_at, ends_at, client, access_token_hash)
       values ('refcnt-studio-booking', 'reg-studio', 'shoot', now(), now() + interval '1 hour',
               '{"name":"Тест","phone":"+7","referenceCount":2}'::jsonb, 'refcnt-hash')`
    )
    const { anonymizeClient } = await import('../src/services/bookings')
    await anonymizeClient('reg-studio', 'refcnt-studio-booking')
    const r = await pool.query(
      `select client->>'referenceCount' as rc from bookings where id = 'refcnt-studio-booking'`
    )
    expect(r.rows[0].rc).toBeNull()
  })
})
