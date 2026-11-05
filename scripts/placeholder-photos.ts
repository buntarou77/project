import fs from 'node:fs'
import path from 'node:path'

// Генерирует временные SVG-изображения для образца (только для demo-тенантов).
// Реальные фотографии владельца всегда важнее — скрипт не перезаписывает существующие файлы.

const PALETTES: Record<string, [string, string, string]> = {
  portrait: ['#efe6d8', '#d8c3a5', '#8a7256'],
  family: ['#e8ecdf', '#c6d0b0', '#7d8a5f'],
  'love story': ['#f3e2e0', '#e0b8b4', '#a96f68'],
  'бизнес и контент': ['#e3e8ee', '#b8c4d4', '#5c6f8a'],
  предметная: ['#f0ece4', '#d6cfc0', '#8f8776'],
  видео: ['#2a2723', '#4a4438', '#a49a84'],
  'интерьер студии': ['#f4efe6', '#ded4c2', '#a3907a'],
  свадьба: ['#f5f0ea', '#e3d5c6', '#b09a83'],
}

function svgFor(label: string, category: string, w = 1600, h = 1200): string {
  const key = Object.keys(PALETTES).find((k) => label.toLowerCase().includes(k) || category.toLowerCase().includes(k)) ?? 'интерьер студии'
  const [a, b, c] = PALETTES[key] ?? PALETTES['интерьер студии']
  const seed = [...label].reduce((s, ch) => s + ch.charCodeAt(0), 0)
  const lx = 18 + (seed % 55)
  const ly = 20 + ((seed >> 3) % 45)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${a}"/>
      <stop offset="1" stop-color="${b}"/>
    </linearGradient>
    <radialGradient id="l" cx="${lx}%" cy="${ly}%" r="70%">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <rect width="${w}" height="${h}" fill="url(#l)"/>
  <circle cx="${(w * (lx + 15)) / 100}" cy="${(h * ly) / 100}" r="${h / 5}" fill="${c}" opacity="0.14"/>
  <text x="50%" y="50%" text-anchor="middle" font-family="Georgia, serif" font-size="${h / 11}" fill="${c}">${label}</text>
  <text x="50%" y="${50 + 8}%" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${h / 34}" fill="${c}" opacity="0.8">временное изображение · замените фото владельца</text>
</svg>\n`
}

export function placeholderPhotos(): void {
  const tenantsDir = 'tenants'
  for (const slug of fs.readdirSync(tenantsDir)) {
    const cfgPath = path.join(tenantsDir, slug, 'tenant.json')
    if (!fs.existsSync(cfgPath)) continue
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    const photoDir = path.join(tenantsDir, slug, 'photos')
    fs.mkdirSync(photoDir, { recursive: true })
    let made = 0
    for (const item of cfg.portfolio ?? []) {
      const file = item.src.replace(/^photos\//, '')
      const dest = path.join(photoDir, file)
      if (fs.existsSync(dest)) continue
      const label = item.caption || item.category
      fs.writeFileSync(dest, svgFor(label, item.category, 1600, item.category === 'видео' ? 900 : 1200))
      made++
    }
    if (made) console.log(`${slug}: +${made} placeholder svg`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  placeholderPhotos()
}
