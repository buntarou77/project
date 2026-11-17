// Воркер уведомлений (§7.5): отдельный процесс, не HTTP.
import { startNotifyWorker } from '../services/notify'

startNotifyWorker()

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
