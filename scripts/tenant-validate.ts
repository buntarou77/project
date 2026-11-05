import fs from 'node:fs'
import path from 'node:path'
import { validateTenantConfig } from '../src/core/schema'

const slugArg = process.argv.find((a) => a.startsWith('--slug='))?.split('=')[1]
const targets = slugArg
  ? [path.join('tenants', slugArg)]
  : fs.readdirSync('tenants', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join('tenants', e.name))

let failed = 0
for (const tenantDir of targets) {
  const slugName = path.basename(tenantDir)
  const cfgPath = path.join(tenantDir, 'tenant.json')
  if (!fs.existsSync(cfgPath)) continue
  try {
    const cfg = validateTenantConfig(JSON.parse(fs.readFileSync(cfgPath, 'utf8')))
    const ids = new Set<string>()
    for (const s of [...cfg.specialists.map((x) => x.id), ...cfg.halls.map((x) => x.id), ...cfg.services.map((x) => x.id)]) {
      if (ids.has(s)) throw new Error(`дублирующийся id: ${s}`)
      ids.add(s)
    }
    for (const svc of cfg.services) {
      if (svc.needsHall && !cfg.halls.length) throw new Error(`услуга ${svc.id} требует зал, но залов нет`)
      if (svc.needsSpecialist && !cfg.specialists.length) throw new Error(`услуга ${svc.id} требует специалиста`)
      if (svc.defaultHallId && !cfg.halls.some((h) => h.id === svc.defaultHallId)) throw new Error(`услуга ${svc.id}: defaultHallId не найден`)
    }
    for (const p of cfg.portfolio) {
      const photo = path.join(tenantDir, p.src)
      if (!fs.existsSync(photo)) throw new Error(`нет файла фото: ${p.src}`)
    }
    if (cfg.settings.modes.rental && !cfg.halls.length) throw new Error('режим аренды включён, но залов нет')
    console.log(`✓ ${slugName}`)
  } catch (e) {
    failed++
    console.error(`✗ ${slugName}: ${e instanceof Error ? e.message : e}`)
  }
}
process.exit(failed ? 1 : 0)
