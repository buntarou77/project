import { config } from './config'
import { buildApp } from './app'
import { startNotifyWorker } from './services/notify'

const app = buildApp()

app.listen(config.PORT, () => {
  console.log(`API: http://localhost:${config.PORT} (${config.NODE_ENV})`)
  if (process.env.DISABLE_WORKER !== '1') startNotifyWorker()
})
