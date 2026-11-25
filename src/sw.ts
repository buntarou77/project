import { precacheAndRoute, type PrecacheEntry } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { StaleWhileRevalidate } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

// Типы SW-окружения объявлены локально: общий tsconfig собирает приложение с
// lib DOM, а полноценный lib WebWorker конфликтует с DOM на глобалах.
interface SWExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void
}
interface SWPushEvent extends SWExtendableEvent {
  readonly data: { json(): unknown; text(): string } | null
}
interface SWNotificationClickEvent extends SWExtendableEvent {
  readonly notification: Notification
}
interface SWClient {
  readonly url: string
  focus(): Promise<unknown>
}
interface SWClients {
  claim(): Promise<unknown>
  matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<SWClient[]>
  openWindow(url: string): Promise<unknown>
}
interface ServiceWorkerGlobalScope {
  readonly clients: SWClients
  readonly registration: ServiceWorkerRegistration
  skipWaiting(): Promise<unknown>
  addEventListener(type: 'push', listener: (event: SWPushEvent) => void): void
  addEventListener(type: 'notificationclick', listener: (event: SWNotificationClickEvent) => void): void
  addEventListener(type: 'activate', listener: (event: SWExtendableEvent) => void): void
}

declare const self: ServiceWorkerGlobalScope & typeof globalThis & { __WB_MANIFEST: (string | PrecacheEntry)[] }

self.skipWaiting()
self.clients.claim()
precacheAndRoute(self.__WB_MANIFEST)

// Картинки: StaleWhileRevalidate — перенесено из generateSW runtimeCaching,
// в режиме injectManifest эти опции конструктора не работают.
// B-66: в кэш картинок попадают только публичные файлы. Ответы API (приватные
// референсы кабинета) Workbox иначе клал бы в Cache Storage, несмотря на no-store
registerRoute(
  ({ request, url }) => request.destination === 'image' && !url.pathname.startsWith('/api/'),
  new StaleWhileRevalidate({
    cacheName: 'images-public',
    plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 14 })],
  })
)

// старый кэш с приватными картинками удаляем при первом запуске новой версии SW
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete('images'))
})

interface PushPayload {
  title: string
  body: string
  icon?: string
  url?: string
}

function readPayload(event: SWPushEvent): PushPayload {
  let obj: Record<string, unknown> = {}
  if (event.data) {
    try {
      const parsed: unknown = event.data.json()
      obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { body: event.data.text() }
    } catch {
      obj = { body: event.data.text() }
    }
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  return {
    title: str(obj.title) ?? 'Напоминание о записи',
    body: str(obj.body) ?? '',
    icon: str(obj.icon),
    url: str(obj.url),
  }
}

// Иконок в корне сайта нет (манифесты и иконки per-tenant в /s/<slug>/),
// а SW живёт на scope «/» и слага не знает. Если вкладка студии открыта —
// берём иконку из её URL; иначе остаётся icon из payload.
async function tenantIcon(): Promise<string | undefined> {
  const clients = await self.clients.matchAll({ type: 'window' })
  for (const c of clients) {
    const m = c.url.match(/^https?:\/\/[^/]+\/s\/([^/]+)\//)
    if (m) return `/s/${m[1]}/icons/icon-192.png`
  }
  return undefined
}

self.addEventListener('push', (event) => {
  const payload = readPayload(event)
  event.waitUntil(
    (async () => {
      const icon = payload.icon ?? (await tenantIcon())
      // vibrate есть в спеке, но отсутствует в lib.dom NotificationOptions
      const options: NotificationOptions & { vibrate?: number[] } = {
        body: payload.body,
        tag: 'booking-reminder',
        icon,
        vibrate: [100, 50, 100],
        data: { url: payload.url },
      }
      await self.registration.showNotification(payload.title, options)
    })()
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const raw = (event.notification.data as { url?: unknown } | null)?.url
  const target = typeof raw === 'string' && raw.startsWith('/') ? raw : '/'
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const match = clients.find((c) => new URL(c.url).pathname === target)
      // фокусируем только вкладку с нужной страницей; «первую попавшуюся»
      // вкладку сайта не подставляем — клик должен открыть назначение
      if (match) await match.focus()
      else await self.clients.openWindow(target)
    })()
  )
})
