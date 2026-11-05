// Проверка опубликованной студии: pnpm tenant:check --slug=X --url=https://…
// Или PLATFORM_URL из окружения. Проверяет: страница, манифест, конфиг, заголовок.

const slug = process.argv.find((a) => a.startsWith('--slug='))?.split('=')[1]
const base = (process.argv.find((a) => a.startsWith('--url='))?.split('=')[1] ?? process.env.PLATFORM_URL ?? 'http://localhost:4173').replace(/\/$/, '')

if (!slug) {
  console.error('Использование: pnpm tenant:check --slug=kadr-studio --url=https://…')
  process.exit(1)
}

async function check(path: string, expectText?: string): Promise<boolean> {
  const res = await fetch(`${base}${path}`)
  const text = await res.text()
  const okStatus = res.ok
  const okText = !expectText || text.includes(expectText)
  console.log(`${okStatus && okText ? '✓' : '✗'} ${path} → ${res.status}${okText ? '' : ` (нет «${expectText}»)`}`)
  return okStatus && okText
}

const results = [
  await check(`/s/${slug}`, 'div id="root"'),
  await check(`/s/${slug}/manifest.webmanifest`, `"start_url": "/s/${slug}/"`),
  await check(`/tenants/${slug}/tenant.json`, `"slug": "${slug}"`),
]
process.exit(results.every(Boolean) ? 0 : 1)
