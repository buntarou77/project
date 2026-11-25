// Применяет миграции server/migrations/*.sql по порядку (таблица _migrations).
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pool, tx } from '../src/db'

async function main() {
  await pool.query(`create table if not exists _migrations (name text primary key, applied_at timestamptz default now())`)
  const dir = path.resolve(__dirname, '../migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const applied = await tx(async (c) => {
      await c.query(`lock table _migrations in exclusive mode`)
      if ((await c.query(`select 1 from _migrations where name = $1`, [file])).rows.length) return false
      await c.query(readFileSync(path.join(dir, file), 'utf8'))
      await c.query(`insert into _migrations (name) values ($1)`, [file])
      return true
    })
    console.log(applied ? `✓ ${file}` : `⏭ ${file} (уже применена)`)
  }
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
