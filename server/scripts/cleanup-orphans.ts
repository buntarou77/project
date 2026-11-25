import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { config } from '../src/config'
import { pool, query } from '../src/db'

async function main() {
  // B-11: по умолчанию dry-run, реальное удаление — только с --apply
  const apply = process.argv.includes('--apply')
  console.log(apply ? 'uploads: режим apply' : 'uploads: dry-run (ничего не удаляется; для удаления запустите с --apply)')
  const root = path.resolve(config.UPLOADS_DIR)
  const known = new Set(
    (await query<{ file_path: string }>(`select file_path from booking_references`)).rows.map((r) => r.file_path)
  )

  if (!existsSync(root)) {
    console.log(`uploads: каталог ${root} не найден — чистить нечего`)
    await pool.end()
    return
  }

  let scanned = 0
  let removed = 0
  for (const studio of readdirSync(root, { withFileTypes: true })) {
    if (!studio.isDirectory()) continue
    const refsDir = path.join(root, studio.name, 'references')
    if (!existsSync(refsDir)) continue
    for (const file of readdirSync(refsDir, { withFileTypes: true })) {
      if (!file.isFile()) continue
      scanned++
      const rel = path.relative(root, path.join(refsDir, file.name)).split(path.sep).join('/')
      if (!known.has(rel)) {
        const fullPath = path.join(refsDir, file.name)
        // Файл попадает на диск раньше строки в booking_references — свежие загрузки (до часа) не трогаем
        const ageMin = (Date.now() - statSync(fullPath).mtimeMs) / 60_000
        if (ageMin < 60) continue
        if (apply) rmSync(fullPath, { force: true })
        else console.log(`  будет удалён: ${rel}`)
        removed++
      }
    }
  }

  console.log(apply ? `uploads: проверено ${scanned}, удалено сирот ${removed}` : `uploads: проверено ${scanned}, сирот к удалению ${removed}`)
  await pool.end()
}

main().catch(async (e) => {
  console.error('cleanup:orphans:', e instanceof Error ? e.message : e)
  await pool.end()
  process.exit(1)
})
