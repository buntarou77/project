import fs from 'node:fs'
import path from 'node:path'
import { validateTenantConfig } from '../src/core/schema'
import { placeholderPhotos } from './placeholder-photos'

// Готовит публичные ассеты тенантов:
//   public/tenants/<slug>/tenant.json + photos  (демо-режим без базы)
//   public/s/<slug>/manifest.webmanifest + icons (PWA per-tenant)

const tenantsDir = 'tenants'
const publicDir = 'public'

function iconSvg(letter: string, accent: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="${accent}"/>
  <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-family="Georgia, serif" font-size="288" fill="#ffffff">${letter}</text>
</svg>`
}

async function main() {
  placeholderPhotos()
  const index: { slug: string; name: string }[] = []
  for (const slug of fs.readdirSync(tenantsDir)) {
    const cfgPath = path.join(tenantsDir, slug, 'tenant.json')
    if (!fs.existsSync(cfgPath)) continue
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    const cfg = validateTenantConfig(raw)

    fs.mkdirSync(path.join(publicDir, 'tenants', slug, 'photos'), { recursive: true })
    fs.copyFileSync(cfgPath, path.join(publicDir, 'tenants', slug, 'tenant.json'))
    const photoDir = path.join(tenantsDir, slug, 'photos')
    if (fs.existsSync(photoDir)) {
      for (const f of fs.readdirSync(photoDir)) {
        fs.copyFileSync(path.join(photoDir, f), path.join(publicDir, 'tenants', slug, 'photos', f))
      }
    }

    const manifestDir = path.join(publicDir, 's', slug)
    fs.mkdirSync(manifestDir, { recursive: true })
    const manifest = {
      name: cfg.settings.name,
      short_name: cfg.settings.name.slice(0, 12),
      description: cfg.settings.tagline,
      start_url: `/s/${slug}/`,
      scope: `/s/${slug}/`,
      display: 'standalone',
      background_color: '#faf7f2',
      theme_color: cfg.settings.accent,
      lang: 'ru',
      icons: [
        { src: `icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
        { src: `icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
        { src: `icons/apple-touch-icon.png`, sizes: '180x180', type: 'image/png', purpose: 'any' },
      ],
    }
    fs.writeFileSync(path.join(manifestDir, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2))

    const { default: sharp } = await import('sharp')
    fs.mkdirSync(path.join(manifestDir, 'icons'), { recursive: true })
    const svg = Buffer.from(iconSvg(cfg.settings.name.replace(/[^\p{L}]/gu, '').charAt(0) ?? 'Ф', cfg.settings.accent))
    await sharp(svg).resize(192, 192).png().toFile(path.join(manifestDir, 'icons', 'icon-192.png'))
    await sharp(svg).resize(512, 512).png().toFile(path.join(manifestDir, 'icons', 'icon-512.png'))
    await sharp(svg).resize(180, 180).png().toFile(path.join(manifestDir, 'icons', 'apple-touch-icon.png'))
    index.push({ slug, name: cfg.settings.name })
    console.log(`assets: ${slug} ✓`)
  }
  fs.mkdirSync(path.join(publicDir, 'tenants'), { recursive: true })
  fs.writeFileSync(path.join(publicDir, 'tenants', 'index.json'), JSON.stringify(index, null, 2))
  console.log('assets: index.json ✓')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
