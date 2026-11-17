// Скачивает шрифты со своего домена (Google Fonts css2), кириллица + латиница.
// v2: комментарий сабсета привязан к СВОЕМУ блоку (регуляркой), дедупликация.
import fs from 'node:fs'
import path from 'node:path'

const CSS_URL =
  'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Manrope:wght@400;500;600;700&display=swap'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'

const res = await fetch(CSS_URL, { headers: { 'User-Agent': UA } })
const css = await res.text()

// /* cyrillic */ @font-face { ... src:url(...woff2) ... unicode-range: ... }
const re = /\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g

const wanted = []
const seen = new Set()
for (const m of css.matchAll(re)) {
  const subset = m[1]
  const body = m[2]
  const family = body.match(/font-family:\s*'([^']+)'/)?.[1]
  const weight = body.match(/font-weight:\s*(\d+)/)?.[1]
  const url = body.match(/url\((https:[^)]+\.woff2)\)/)?.[1]
  const range = body.match(/unicode-range:\s*([^;]+);/)?.[1]
  if (!family || !weight || !url || !range) continue
  if (!['cyrillic', 'latin'].includes(subset)) continue
  const key = `${family}|${weight}|${subset}`
  if (seen.has(key)) continue
  seen.add(key)
  wanted.push({ family, weight, subset, url, range })
}

const outDir = 'public/fonts'
fs.mkdirSync(outDir, { recursive: true })
const lines = []
for (const w of wanted) {
  const slug = w.family.toLowerCase().replace(/\s+/g, '-')
  const file = `${slug}-${w.weight}-${w.subset}.woff2`
  const buf = Buffer.from(await (await fetch(w.url)).arrayBuffer())
  fs.writeFileSync(path.join(outDir, file), buf)
  lines.push(
    `@font-face{font-family:'${w.family}';font-style:normal;font-weight:${w.weight};font-display:swap;src:url('/fonts/${file}') format('woff2');unicode-range:${w.range};}`
  )
  console.log('ok', file)
}
fs.writeFileSync('src/ui/fonts.css', lines.join('\n') + '\n')
console.log('fonts.css:', lines.length, 'faces')
