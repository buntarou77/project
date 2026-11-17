import { query } from '../db'
import { sendMail } from './mail'
import { sendPushToStudio } from './push'
import { config } from '../config'

// Очередь уведомлений с ретраями: email (SMTP) и Web Push (VAPID) — §7.5.

const BACKOFF_SEC = [60, 300, 900, 3600, 21600]
const MAX_ATTEMPTS = BACKOFF_SEC.length

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
    const pushed = await sendPushToStudio(row.studio_id, title, text, { icon, url })
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
      ok = (await sendMail(to, title, text)) && ok
    }
    parts.push(ok ? 'email:ok' : 'email:fail')
  } else {
    parts.push('email:skipped(no smtp)')
  }

  const pushed = await sendPushToStudio(row.studio_id, title, text)
  parts.push(pushed ? 'push:ok' : 'push:skipped(no vapid/subs)')
  return parts.join(',')
}

export async function dispatchPendingOnce(): Promise<number> {
  const rows = await query<{
    id: string
    studio_id: string
    channel: string
    attempts: number
    payload: Record<string, unknown>
  }>(
    `select id, studio_id, channel, attempts, payload from notify_outbox
     where status = 'pending' and next_attempt_at <= now() and attempts < $1
     order by created_at limit 20`,
    [MAX_ATTEMPTS]
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
        `update notify_outbox set attempts=$2, last_error=$3,
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
}

export function startNotifyWorker(intervalMs = 30_000): void {
  const tick = () =>
    dispatchPendingOnce().catch((e) => console.error('notify worker:', e instanceof Error ? e.message : e))
  void tick()
  setInterval(tick, intervalMs)
  console.log(`notify worker: интервал ${intervalMs / 1000}s`)
}
