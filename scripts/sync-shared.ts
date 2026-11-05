import fs from 'node:fs'
import path from 'node:path'

// Синхронизирует чистую логику из src/core в supabase/functions/_shared/core
// и превращает bare-импорты в Deno-спецификаторы (npm:...).

const srcDir = path.resolve('src/core')
const outDir = path.resolve('supabase/functions/_shared/core')
fs.mkdirSync(outDir, { recursive: true })

const NPM = ['zod', 'date-fns-tz', 'date-fns']

for (const file of fs.readdirSync(srcDir)) {
  if (!file.endsWith('.ts')) continue
  let code = fs.readFileSync(path.join(srcDir, file), 'utf8')
  for (const pkg of NPM) {
    code = code.replaceAll(`from '${pkg}'`, `from 'npm:${pkg}'`)
    code = code.replaceAll(`from '${pkg}/`, `from 'npm:${pkg}/`)
  }
  fs.writeFileSync(path.join(outDir, file), code)
}
console.log('synced core →', outDir)
