// Приглашение в студию: создаёт токен, шлёт письмо (если SMTP+email) и печатает ссылку.
import { query, pool } from '../src/db'
import { createInvitation } from '../src/services/invitations'
import { config } from '../src/config'

const slug = process.argv.find((a) => a.startsWith('--slug='))?.split('=')[1]
const email = process.argv.find((a) => a.startsWith('--email='))?.split('=')[1] ?? null
const role = (process.argv.find((a) => a.startsWith('--role='))?.split('=')[1] ?? 'owner') as
  | 'owner'
  | 'manager'
  | 'employee'

if (!slug) {
  console.error('Использование: pnpm studio:invite --slug=kadr-studio [--email=owner@example.ru] [--role=owner]')
  process.exit(1)
}

async function main() {
  const studio = await query<{ id: string; name: string }>(
    `select id, settings->>'name' as name from studios where slug = $1`,
    [slug]
  )
  if (studio.rows.length === 0) {
    console.error(`Студия «${slug}» не найдена. Сначала pnpm studio:create --slug=${slug}`)
    process.exit(1)
  }
  const created = await createInvitation({ studioId: studio.rows[0].id, email, role })
  console.log(`Приглашение создано: ${studio.rows[0].name} · роль ${created.role}`)
  console.log(`Действует до: ${created.expiresAt}`)
  console.log(`Ссылка: ${created.url}`)
  if (!email) console.log('(без email — передайте ссылку вручную, срок 48 часов)')
  if (email && !config.SMTP_URL) console.log('(SMTP_URL не задан — письмо не отправлено, передайте ссылку вручную)')
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
