import { query } from '../db'
import { sendMail } from './mail'
import { sendPushToBooking } from './push'
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

// Как клиент просил с ним связаться — подпись для письма владельцу
const CONTACT_METHOD_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  phone: 'телефон',
}

async function deliver(row: {
  id: string
  studio_id: string
  booking_id: string | null
  channel: string
  payload: Record<string, unknown>
}): Promise<string> {
  const title = String(row.payload.title ?? 'Новое уведомление')
  const text = String(row.payload.body ?? '')

  // напоминание клиенту: только web-push и только на устройства, где включали
  // напоминания для ЭТОЙ записи. Подписка без брони ничего не получает; нет
  // VAPID/подписок — тишина, это норма.
  if (row.channel === 'reminder_client') {
    const icon = typeof row.payload.icon === 'string' ? row.payload.icon : undefined
    const url = typeof row.payload.url === 'string' ? row.payload.url : undefined
    const r = await withDeliverTimeout(
      sendPushToBooking(row.booking_id, title, text, { icon, url }),
      'push'
    )
    return r === 'ok' ? 'push:ok' : r === 'fail' ? 'push:fail' : 'push:skipped(no subs)'
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

  // push для этих каналов не шлём: подписки студии — это устройства клиентов
  // витрины, и они получали заявки с чужими именами
  const lines = [text]
  if (typeof row.payload.phone === 'string' && row.payload.phone) lines.push(`Телефон: ${row.payload.phone}`)
  const method =
    typeof row.payload.method === 'string'
      ? (CONTACT_METHOD_LABELS[row.payload.method] ?? row.payload.method)
      : ''
  if (method) lines.push(`Связь: ${method}`)
  if (typeof row.payload.notes === 'string' && row.payload.notes) lines.push(`Комментарий: ${row.payload.notes}`)
  lines.push(`Кабинет: ${config.WEB_ORIGIN}/owner`)
  const emailText = lines.join('\n')

  if (config.SMTP_URL && tos.length > 0) {
    // П10: письма получателям — параллельно; последовательные 30-секундные
    // таймауты растягивали доставку на число получателей
    const results = await Promise.allSettled(
      tos.map((to) => withDeliverTimeout(sendMail(to, title, emailText), 'email'))
    )
    // достаточно одной успешной доставки: остальные адреса не держат батч
    const ok = results.some((r) => r.status === 'fulfilled' && r.value === true)
    parts.push(ok ? 'email:ok' : 'email:fail')
  } else {
    // B-54: без SMTP уведомление не доставлено — честный fail уходит в
    // retry/failed, иначе строка помечалась бы обработанной без отправки
    parts.push('email:fail(no smtp)')
  }
  return parts.join(',')
}

let dispatching = false // B6: тик не должен накладываться на предыдущий

export async function dispatchPendingOnce(): Promise<number> {
  if (dispatching) return 0 // предыдущий батч ещё в работе
  dispatching = true
  try {
    // B6: атомарный захват — сразу помечаем 'processing', тогда второй воркер
    // (или повторный тик) эти строки не возьмёт. Токен владения — lease_id:
    // claimed_at содержит микросекунды, а JS Date/pg теряют их до миллисекунд,
    // поэтому сравнение claimed_at с переданным значением отклоняло свой же
    // claim (B-65). claimed_at остаётся только порогом для reclaim.
    const claim = await query<{
      id: string
      studio_id: string
      booking_id: string | null
      channel: string
      attempts: number
      payload: Record<string, unknown>
      lease_id: string
    }>(
      `update notify_outbox set status = 'processing', claimed_at = now(), lease_id = gen_random_uuid()
       where id in (
         select id from notify_outbox
         where status = 'pending' and next_attempt_at <= now() and attempts < $1
         order by created_at limit 20
         for update skip locked
       )
       returning id, studio_id, booking_id, channel, attempts, payload, lease_id`,
      [MAX_ATTEMPTS]
    )
    if (claim.rows.length === 0) return 0
    for (const row of claim.rows) {
      let result = 'unknown'
      // Аренда считается от начала доставки этой строки, а не от захвата пачки:
      // иначе длинный батч «доживал» до reclaim (5 минут) и отправлялся дважды.
      // Заодно продлеваем владение только если строка всё ещё наша.
      const renewed = await query<{ lease_id: string }>(
        `update notify_outbox set claimed_at = now()
         where id = $1 and status = 'processing' and lease_id = $2
         returning lease_id`,
        [row.id, row.lease_id]
      )
      if (renewed.rows.length === 0) continue
      const lease = renewed.rows[0].lease_id
      // B-59: строку могла удалить анонимизация уже после захвата пачки.
      // Повторная проверка перед отправкой не даёт уйти старым контактам.
      // Для строк с бронью одним запросом проверяем и владение, и что клиент
      // не анонимизирован. Отправку, уже принятую транспортом, отозвать нельзя
      // — политика best-effort: эта проверка гарантирует отзыв только до
      // начала отправки.
      const alive = row.booking_id
        ? await query(
            `select 1 from notify_outbox o join bookings b on b.id = o.booking_id
             where o.id = $1 and o.status = 'processing' and o.lease_id = $2
               and b.client->>'name' <> 'Данные удалены'`,
            [row.id, lease]
          )
        : await query(
            `select 1 from notify_outbox where id = $1 and status = 'processing' and lease_id = $2`,
            [row.id, lease]
          )
      if (alive.rows.length === 0) continue
      try {
        result = await deliver(row)
      } catch (e) {
        result = `fail:${e instanceof Error ? e.message : 'error'}`
      }
      // исключение из deliver даёт строку «fail:…» — без startsWith она не
      // распознавалась как неудача, и таймаут помечался обработанным
      const failed = result.startsWith('fail:') || result.includes(':fail')
      const attempts = row.attempts + 1
      if (failed && attempts >= MAX_ATTEMPTS) {
        await query(
          `update notify_outbox set status='failed', attempts=$2, last_error=$3, processed_at=now()
           where id=$1 and status='processing' and lease_id=$4`,
          [row.id, attempts, result, lease]
        )
      } else if (failed) {
        await query(
          `update notify_outbox set status='pending', attempts=$2, last_error=$3,
           next_attempt_at = now() + make_interval(secs => $4)
           where id=$1 and status='processing' and lease_id=$5`,
          [row.id, attempts, result, BACKOFF_SEC[attempts - 1], lease]
        )
      } else {
        await query(
          `update notify_outbox set status='processed', attempts=$2, last_error=$3, processed_at=now()
           where id=$1 and status='processing' and lease_id=$4`,
          [row.id, attempts, result, lease]
        )
      }
    }
    return claim.rows.length
  } finally {
    dispatching = false
  }
}

// Y5 (P4): строки, застрявшие в processing (крэш/зависание), возвращаем в
// pending. Порог 5 минут заведомо больше 30-секундного таймаута доставки.
export async function reclaimStuckNotifications(olderThanSec = RECLAIM_AFTER_SEC): Promise<number> {
  const r = await query(
    `update notify_outbox set status = 'pending', claimed_at = null, lease_id = null
     where status = 'processing' and claimed_at < now() - make_interval(secs => $1)`,
    [olderThanSec]
  )
  return r.rowCount ?? 0
}

// Y5 (P4): встроенный PG не гарантирует pg_cron — чистим очередь в воркере.
let lastCleanupDay = ''

export async function cleanupNotificationData(): Promise<void> {
  const now = new Date()
  const hour = now.getUTCHours() // 03:00–05:59 UTC — минимум нагрузки
  if (hour < 3 || hour > 5) return
  // раз в сутки, а не на каждом тике воркера весь трёхчасовой интервал
  const day = now.toISOString().slice(0, 10)
  if (day === lastCleanupDay) return
  await query(`delete from rate_limits where window_start < now() - interval '2 hours'`)
  await query(`delete from notify_outbox where status in ('processed','failed') and processed_at < now() - interval '7 days'`)
  await query(`delete from refresh_sessions where (revoked_at is not null or expires_at < now()) and created_at < now() - interval '30 days'`)
  // сроки хранения одноразовых токенов: использованные и просроченные больше не нужны
  await query(`delete from password_reset_tokens where expires_at < now() - interval '7 days'`)
  await query(`delete from studio_invitations where expires_at < now() - interval '30 days' and (accepted_at is not null or expires_at < now())`)
  // референсы удаляются через 90 дней после заявки — как обещает политика на витрине
  const { cleanupOldReferences } = await import('./bookings')
  await cleanupOldReferences()
  // B-38: флаг дня — только после успешной уборки референсов; при сбое
  // следующий тик в окне 03:00–05:59 повторит попытку
  lastCleanupDay = day
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
