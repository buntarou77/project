// Проверка SMTP из .env: pnpm smtp:test --to=ваша@почта.ru [--from=noreply@example.ru]
// Письмо уходит через SMTP_URL из .env — удобный тест после покупки провайдера.
import 'dotenv/config'
import nodemailer from 'nodemailer'
import { config } from '../src/config'

async function main() {
  if (!config.SMTP_URL) {
    console.error('SMTP_URL не задан в server/.env')
    process.exit(1)
  }
  const argTo = process.argv.find((a) => a.startsWith('--to='))?.split('=')[1]
  const to = argTo ?? config.OWNER_EMAIL
  if (!to) {
    console.error('Укажите получателя: pnpm smtp:test --to=ваша@почта.ru (или MAIL_FROM/OWNER_EMAIL в .env)')
    process.exit(1)
  }
  const from = config.MAIL_FROM ?? to

  const transport = nodemailer.createTransport(config.SMTP_URL)
  await transport.verify()
  console.log('✓ SMTP-соединение и авторизация: OK')

  const info = await transport.sendMail({
    from,
    to,
    subject: 'Тест SMTP — платформа записи',
    text: `Проверка отправки ${new Date().toISOString()}`,
  })
  console.log(`✓ Письмо отправлено → ${to} (id: ${info.messageId})`)
  process.exit(0)
}

main().catch((e) => {
  console.error('✗ Ошибка:', e instanceof Error ? e.message : e)
  process.exit(1)
})
