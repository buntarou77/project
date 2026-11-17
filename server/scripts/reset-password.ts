// Сброс пароля без SMTP: генерирует одноразовую ссылку /reset/<токен> и печатает
// её в консоль — передайте владельцу любым каналом (Telegram, звонок).
// Использование: pnpm user:reset --email=owner@example.ru
import { query, pool } from '../src/db'
import { randomToken, sha256Hex } from '../src/services/tokens'
import { config } from '../src/config'

const email = process.argv.find((a) => a.startsWith('--email='))?.split('=')[1]

if (!email) {
  console.error('Использование: pnpm user:reset --email=owner@example.ru')
  process.exit(1)
}

async function main() {
  const u = await query<{ id: string }>(
    `select id from users where email = $1 and is_active = true`,
    [email]
  )
  if (u.rows.length === 0) {
    console.error(`Пользователь «${email}» не найден`)
    process.exit(1)
  }
  const raw = randomToken()
  await query(
    `insert into password_reset_tokens (user_id, token_hash, expires_at)
     values ($1, $2, now() + interval '1 hour')`,
    [u.rows[0].id, sha256Hex(raw)]
  )
  console.log(`Ссылка сброса пароля (действует 1 час):`)
  console.log(`${config.WEB_ORIGIN}/reset/${raw}`)
  console.log(`Передайте её пользователю — он задаст новый пароль на странице.`)
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
