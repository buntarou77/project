import webpush from 'web-push'
import { query } from '../db'
import { config } from '../config'
import { sha256Hex } from './tokens'

let configured = false

function ensure(): boolean {
  if (configured) return true
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) return false
  webpush.setVapidDetails('mailto:admin@photo-booking.local', config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY)
  configured = true
  return true
}

// Подписка витрины привязана к брони, на которой клиент включил напоминания.
// payload — ровно тот объект, который ждёт sendNotification
// ({endpoint, keys, expirationTime}) — что кладём при подписке, то и отправляем.
export async function savePushSubscription(
  studioId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  bookingId: string
): Promise<void> {
  const payload = JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, expirationTime: null })
  await query(
    `insert into push_subscriptions (studio_id, endpoint_hash, payload, booking_id)
     values ($1, $2, $3::jsonb, $4)
     on conflict (studio_id, endpoint_hash, coalesce(booking_id, '')) do update
       set payload = excluded.payload`,
    [studioId, sha256Hex(sub.endpoint), payload, bookingId]
  )
}

export async function deletePushSubscription(studioId: string, endpoint: string): Promise<void> {
  await query(`delete from push_subscriptions where studio_id = $1 and endpoint_hash = $2`, [
    studioId,
    sha256Hex(endpoint),
  ])
}

export type PushDelivery = 'ok' | 'no-subs' | 'fail'

// Push по конкретной брони: только её подписки, а не вся студия.
// 404/410 от push-сервиса — подписка мертва, удаляем, чтобы не ходить по ней вечно.
// opts.icon/url прокладываются в payload: SW витрины показывает icon и
// открывает url по клику (fallback-логика — в src/sw.ts)
export async function sendPushToBooking(
  bookingId: string | null,
  title: string,
  body: string,
  opts?: { icon?: string; url?: string }
): Promise<PushDelivery> {
  if (!ensure()) return 'no-subs'
  if (!bookingId) return 'no-subs'
  const subs = await query<{ id: string; payload: unknown }>(
    `select id, payload from push_subscriptions where booking_id = $1`,
    [bookingId]
  )
  if (subs.rows.length === 0) return 'no-subs'
  let delivered = false
  let failed = false
  for (const row of subs.rows) {
    try {
      await webpush.sendNotification(
        row.payload as never,
        JSON.stringify({
          title,
          body,
          ...(opts?.icon ? { icon: opts.icon } : {}),
          ...(opts?.url ? { url: opts.url } : {}),
        })
      )
      delivered = true
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) {
        // подписка отозвана или устарела — больше по ней не ходим
        await query(`delete from push_subscriptions where id = $1`, [row.id]).catch(() => undefined)
      } else {
        failed = true
      }
    }
  }
  return delivered ? 'ok' : failed ? 'fail' : 'no-subs'
}
