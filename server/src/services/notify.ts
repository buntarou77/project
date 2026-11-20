import { query } from '../db'
import { sendMail } from './mail'
import { sendPushToStudio } from './push'
import { config } from '../config'

// Очередь уведомлений с ретраями: email (SMTP) и Web Push (VAPID) — §7.5.

const BACKOFF_SEC = [60, 300, 900, 3600, 21600]
const MAX_ATTEMPTS = BACKOFF_SEC.length
const DELIVER_TIMEOUT_MS = 30_000
const RECLAIM_AFTER_SEC = 300

export async function enqueueNotify(
  studioId: string,
  channel: string,
  payload: Record<string, unknown>,
  bookingId?: string | null,
  // отложенная доставка (напоминание за сутки): когда воркер должен отправить
  sendAt?: Date
): Promise<void> {
  await query(
    `insert into notify_outbox (studio_id, booking_id, channel, payload, next_attempt_at) values ($1, $2, $3, $4, $5)`,
    [studioId, bookingId ?? null, channel, JSON.stringify(payload), sendAt ?? new Date()]
  )
}

// Y5 (P4): один зависший sendMail не должен навсегда занимать строку.
// Promise.race не отменяет сам запрос, но освобождает очередь и запускает retry.
function withDeliverTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timeout`)), DELIVER_TIMEOUT_MS)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) }
    )
  })
}

async function deliver(row: {
  id: string
  studio_id: string
  channel: string
  payload: Record<string, unknown>
}): Promise<string> {
  const title = String(row.payload.title ?? 'Новое уведомление')
  const text = String(row.payload.body ?? '')

  // напоминание клиенту: только web-push по подпискам студии; письмо
  // владельцу здесь не нужно. Нет VAPID/подписок — тишина, это норма.
  if (row.channel === 'reminder_client') {
    const icon = typeof row.payload.icon === 'string' ? row.payload.icon : undefined
    const url = typeof row.payload.url === 'string' ? row.payload.url : undefined
    const pushed = await withDeliverTimeout(
      sendPushToStudio(row.studio_id, title, text, { icon, url }),
      'push'
    )
    return pushed ? 'push:ok' : 'push:skipped(no vapid/subs)'
  }

  const parts: string[] = []

  // письмо всем владельцам и менеджерам студии (не только первому owner);
  // OWNER_EMAIL — запасной вариант, если подписчиков нет
  let tos: string[] = []
  if (row.studio_id) {
    const owners = await query<{ email: string }>(
      `select u.email::text as email from memberships m join users u on u.id = m.user_id
       where m.studio_id = $1 and m.role in ('owner','manager') and u.is_active = true`,
      [row.studio_id]
    )
    tos = owners.rows.map((r) => r.email)
  }
  if (tos.length === 0 && config.OWNER_EMAIL) tos = [config.OWNER_EMAIL]

  if (config.SMTP_URL && tos.length > 0) {
    let ok = true
    for (const to of tos) {
      ok = (await withDeliverTimeout(sendMail(to, title, text), 'email')) && ok
    }
    parts.push(ok ? 'email:ok' : 'email:fail')
  } else {
    parts.push('email:skipped(no smtp)')
  }

  const pushed = await withDeliverTimeout(sendPushToStudio(row.studio_id, title, text), 'push')
  parts.push(pushed ? 'push:ok' : 'push:skipped(no vapid/subs)')
  return parts.join(',')
}

let dispatching = false // B6: тик не должен накладываться на предыдущий

export async function dispatchPendingOnce(): Promise<number> {
  if (dispatching) return 0 // предыдущий батч ещё в работе
  dispatching = true
  try {
    // B6: атомарный захват — сразу помечаем 'processing', тогда второй воркер
    // (или повторный тик) эти строки не возьмёт. Возврат к pending при ошибке.
    const claim = await query<{ id: string }>(
      `update notify_outbox set status = 'processing', claimed_at = now()
       where id in (
         select id from notify_outbox
         where status = 'pending' and next_attempt_at <= now() and attempts < $1
         order by created_at limit 20
         for update skip locked
       )
       returning id`,
      [MAX_ATTEMPTS]
    )
    if (claim.rows.length === 0) return 0
    const ids = claim.rows.map((r) => r.id)
    const rows = await query<{
      id: string
      studio_id: string
      channel: string
      attempts: number
      payload: Record<string, unknown>
    }>(
      `select id, studio_id, channel, attempts, payload from notify_outbox
       where id = any($1)`,
      [ids]
    )
    for (const row of rows.rows) {
      let result = 'unknown'
      try {
        result = await deliver(row)
      } catch (e) {
        result = `fail:${e instanceof Error ? e.message : 'error'}`
      }
      const failed = result.includes(':fail')
      const attempts = row.attempts + 1
      if (failed && attempts >= MAX_ATTEMPTS) {
        await query(
          `update notify_outbox set status='failed', attempts=$2, last_error=$3, processed_at=now() where id=$1`,
          [row.id, attempts, result]
        )
      } else if (failed) {
        await query(
          `update notify_outbox set status='pending', attempts=$2, last_error=$3,
           next_attempt_at = now() + make_interval(secs => $4) where id=$1`,
          [row.id, attempts, result, BACKOFF_SEC[attempts - 1]]
        )
      } else {
        await query(
          `update notify_outbox set status='processed', attempts=$2, last_error=$3, processed_at=now() where id=$1`,
          [row.id, attempts, result]
        )
      }
    }
    return rows.rows.length
  } finally {
    dispatching = false
  }
}

// Y5 (P4): строки, застрявшие в processing (крэш/зависание), возвращаем в
// pending. Порог 5 минут заведомо больше 30-секундного таймаута доставки.
export async function reclaimStuckNotifications(olderThanSec = RECLAIM_AFTER_SEC): Promise<number> {
  const r = await query(
    `update notify_outbox set status = 'pending', claimed_at = null
     where status = 'processing' and claimed_at < now() - make_interval(secs => $1)`,
    [olderThanSec]
  )
  return r.rowCount ?? 0
}

// Y5 (P4): встроенный PG не гарантирует pg_cron — чистим очередь в воркере.
export async function cleanupNotificationData(): Promise<void> {
  const hour = new Date().getUTCHours() // 03:00–05:59 UTC — минимум нагрузки
  if (hour < 3 || hour > 5) return
  await query(`delete from rate_limits where window_start < now() - interval '2 hours'`)
  await query(`delete from notify_outbox where status in ('processed','failed') and processed_at < now() - interval '7 days'`)
  await query(`delete from refresh_sessions where (revoked_at is not null or expires_at < now()) and created_at < now() - interval '30 days'`)
}

export function startNotifyWorker(intervalMs = 30_000): void {
  // P4: reclaim и при старте, и периодически — иначе после крэша строка висит вечно
  let lastReclaim = Date.now()
  void reclaimStuckNotifications().catch(() => {})

  const tick = async () => {
    const now = Date.now()
    if (now - lastReclaim >= RECLAIM_AFTER_SEC * 1000) {
      lastReclaim = now
      await reclaimStuckNotifications().catch(() => {})
    }
    // Y5 (P4): очистка — раз в сутки в ночное окно, а не каждый час
    await cleanupNotificationData().catch(() => {})
    return dispatchPendingOnce().catch((e) => console.error('notify worker:', e instanceof Error ? e.message : e))
  }
  void tick()
  setInterval(() => void tick(), intervalMs)
  console.log(`notify worker: интервал ${intervalMs / 1000}s`)
}
