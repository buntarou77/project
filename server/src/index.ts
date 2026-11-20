import { config } from './config'
import { buildApp } from './app'
import { startNotifyWorker } from './services/notify'
import { pool } from './db'

const app = buildApp()

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
