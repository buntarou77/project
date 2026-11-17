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

// Подписка витрины: endpoint_hash глобально уникален (миграция 0001), поэтому
// upsert по нему; payload — ровно тот объект, который ждёт sendNotification
// ({endpoint, keys, expirationTime}) — что кладём при подписке, то и отправляем.
export async function savePushSubscription(
  studioId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } }
): Promise<void> {
  const payload = JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, expirationTime: null })
  await query(
    `insert into push_subscriptions (studio_id, endpoint_hash, payload)
     values ($1, $2, $3::jsonb)
     on conflict (endpoint_hash) do update set studio_id = excluded.studio_id, payload = excluded.payload`,
    [studioId, sha256Hex(sub.endpoint), payload]
  )
}

export async function deletePushSubscription(studioId: string, endpoint: string): Promise<void> {
  await query(`delete from push_subscriptions where studio_id = $1 and endpoint_hash = $2`, [
    studioId,
    sha256Hex(endpoint),
  ])
}

// opts.icon/url прокладываются в payload: SW витрины показывает icon и
// открывает url по клику (fallback-логика — в src/sw.ts)
export async function sendPushToStudio(
  studioId: string,
  title: string,
  body: string,
  opts?: { icon?: string; url?: string }
): Promise<boolean> {
  if (!ensure()) return false
  const subs = await query<{ payload: unknown }>(
    `select payload from push_subscriptions where studio_id = $1`,
    [studioId]
  )
  let delivered = false
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
    } catch {
      // недействительная подписка — воркер/следующая отправка её отфильтрует
    }
  }
  return delivered
}
