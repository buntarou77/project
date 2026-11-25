import { config, isProd } from './config'
import { buildApp } from './app'
import { startNotifyWorker } from './services/notify'
import { pool } from './db'

const app = buildApp()

// За reverse-proxy без TRUST_PROXY у всех клиентов один req.ip — лимиты
// становятся общими на всю платформу
if (isProd && !config.TRUST_PROXY) {
  console.warn('TRUST_PROXY не включён: за nginx все клиенты считаются одним IP и делят rate-limit')
}

// Без SMTP владелец не получает никаких уведомлений о заявках (push ему не шлётся)
if (isProd && !config.SMTP_URL) {
  console.warn('SMTP_URL не задан: владелец студии не будет получать письма о новых заявках')
}

const server = app.listen(config.PORT, () => {
  console.log(`API: http://localhost:${config.PORT} (${config.NODE_ENV})`)
  if (process.env.DISABLE_WORKER !== '1') startNotifyWorker()
})

// P5: graceful shutdown — доканчиваем входящие запросы, потом пул
let shuttingDown = false
async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received, shutting down…`)
  server.close(async () => {
    try {
      await pool.end()
      process.exit(0)
    } catch {
      process.exit(1)
    }
  })
  // страховка: если через 10с соединения не закрылись — выходим принудительно
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
