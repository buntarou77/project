// Применяет миграции server/migrations/*.sql по порядку (таблица _migrations).
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pool } from '../src/db'

async function main() {
  await pool.query(`create table if not exists _migrations (name text primary key, applied_at timestamptz default now())`)
  const dir = path.resolve(__dirname, '../migrations')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const done = await pool.query(`select 1 from _migrations where name = $1`, [file])
    if (done.rows.length > 0) {
      console.log(`⏭ ${file} (уже применена)`)
      continue
    }
    const sql = readFileSync(path.join(dir, file), 'utf8')
    await pool.query(sql)
    await pool.query(`insert into _migrations (name) values ($1)`, [file])
    console.log(`✓ ${file}`)
  }
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
