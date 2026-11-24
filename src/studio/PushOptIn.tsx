import { useEffect, useRef, useState } from 'react'
import { backend } from '@/backend'

// Кнопка на экране успешной брони: подписаться на push-напоминание за сутки.
// В демо-режиме и браузерах без Web Push целиком не показывается.

type PushState = 'hidden' | 'idle' | 'busy' | 'on' | 'off'

function pushAvailable(): boolean {
  if (backend.kind === 'demo') return false
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
  return typeof Notification !== 'undefined' && Notification.permission !== 'denied'
}

// VAPID-ключ приходит base64url, а pushManager.subscribe ждёт Uint8Array
// (строго с ArrayBuffer-бэкендом: BufferSource не принимает ArrayBufferLike)
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export default function PushOptIn({ slug, token }: { slug: string; token: string }) {
  const [state, setState] = useState<PushState>('hidden')
  const [note, setNote] = useState('')
  const timer = useRef<number | null>(null)

  // Показать состояние один раз и убрать компонент совсем
  function flash(next: PushState, text: string) {
    if (timer.current !== null) window.clearTimeout(timer.current)
    setState(next)
    setNote(text)
    timer.current = window.setTimeout(() => setState('hidden'), 6000)
  }

  useEffect(() => {
    // без токена брони подписку не к чему привязать
    if (!pushAvailable() || !token) return
    let alive = true
    void (async () => {
      // уже подписаны (повторная запись с того же устройства): подписку нужно
      // привязать к новой брони, иначе напоминание по ней не придёт
      if (Notification.permission === 'granted') {
        try {
          const reg = await navigator.serviceWorker.ready
          const sub = await reg.pushManager.getSubscription()
          if (sub && alive) {
            const json = sub.toJSON()
            if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
              try {
                await backend.pushSubscribe?.(slug, {
                  endpoint: json.endpoint,
                  keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
                }, token)
              } catch {
                // привязать не удалось — покажем кнопку, она попробует ещё раз
                if (alive) setState('idle')
                return
              }
            }
            flash('on', 'Напоминания включены')
            return
          }
        } catch {
          // проверка не удалась — просто покажем кнопку
        }
      }
      if (alive) setState('idle')
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )

  async function enable() {
    setState('busy')
    try {
      const key = await backend.pushKey?.(slug)
      if (!key || key.publicKey === null) {
        flash('off', 'Уведомления недоступны')
        return
      }
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        flash('off', 'Не удалось включить напоминания')
        return
      }
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.publicKey),
      })
      const json = sub.toJSON()
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('bad subscription')
      await backend.pushSubscribe?.(slug, {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }, token)
      flash('on', 'Напоминания включены')
    } catch {
      flash('off', 'Не удалось включить напоминания')
    }
  }

  if (state === 'hidden') return null
  if (state === 'idle' || state === 'busy') {
    return (
      <button className="btn btn-sm" onClick={enable} disabled={state === 'busy'}>
        {state === 'busy' && <span className="spinner-inline" aria-hidden="true" />}
        {state === 'busy' ? 'Включаем…' : 'Включить напоминания об этой записи'}
      </button>
    )
  }
  return <span className={state === 'on' ? 'badge ok' : 'muted small'}>{note}</span>
}
