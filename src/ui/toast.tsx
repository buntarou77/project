import { useSyncExternalStore } from 'react'

// Мини-тосты без зависимостей: toast() из любого места, ToastHost монтируется
// один раз в App. Успех — зелёная плашка, ошибка — красная; исчезают сами.

export type ToastKind = 'ok' | 'err'

export interface ToastItem {
  id: number
  text: string
  kind: ToastKind
}

let items: ToastItem[] = []
const listeners = new Set<() => void>()
let seq = 0

function notify() {
  listeners.forEach((l) => l())
}

export function toast(text: string, kind: ToastKind = 'ok') {
  const t: ToastItem = { id: ++seq, text, kind }
  items = [...items, t]
  notify()
  setTimeout(() => {
    items = items.filter((x) => x.id !== t.id)
    notify()
  }, 2600)
}

// Единая точка показа ошибок API: сообщение из ApiError попадает на экран.
export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : 'Ошибка сервера', 'err')
}

export function ToastHost() {
  const list = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => items
  )
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'ok' ? '✓ ' : '⚠ '}
          {t.text}
        </div>
      ))}
    </div>
  )
}
