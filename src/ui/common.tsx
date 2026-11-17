import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { BookingStatus } from '@/backend/types'
import { STATUS_LABELS } from '@/backend/types'
import { toastError } from './toast'

export function Spinner({ label = 'Загружаем…' }: { label?: string }) {
  return <p className="muted" style={{ padding: '40px 0', textAlign: 'center' }}>{label}</p>
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="card" style={{ borderColor: 'var(--bad)' }}>
      <p style={{ margin: 0, color: 'var(--bad)', fontWeight: 600 }}>{children}</p>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted" style={{ textAlign: 'center', padding: '32px 0' }}>{children}</p>
}

export function Section({ children, className = '', id }: { children: ReactNode; className?: string; id?: string }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add('in')
            io.disconnect()
          }
        }
      },
      { threshold: 0.12 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <section ref={ref} id={id} className={`section reveal ${className}`}>
      <div className="container">{children}</div>
    </section>
  )
}

export function StatusBadge({ status }: { status: BookingStatus }) {
  const tone =
    status === 'new' ? 'warn' : status === 'confirmed' || status === 'prepaid' ? 'ok' : status === 'completed' ? 'acc' : ['cancelled_by_client', 'rejected', 'no_show'].includes(status) ? 'bad' : ''
  return <span className={`badge ${tone}`}>{STATUS_LABELS[status]}</span>
}

export function DemoFlag() {
  return <span className="demo-flag">ОБРАЗЕЦ</span>
}

// Фотолайтбокс на весь экран: Esc/стрелки/свайп. Общий для работ и залов.
export function Lightbox({
  items,
  index,
  onClose,
  onNav,
}: {
  items: { src: string; alt?: string; caption?: string }[]
  index: number
  onClose: () => void
  onNav: (next: number) => void
}) {
  const touchX = useRef<number | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onNav((index - 1 + items.length) % items.length)
      if (e.key === 'ArrowRight') onNav((index + 1) % items.length)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length, onClose, onNav])
  const item = items[index]
  if (!item) return null
  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current === null) return
        const dx = e.changedTouches[0].clientX - touchX.current
        if (Math.abs(dx) > 48) onNav((index + (dx < 0 ? 1 : -1) + items.length) % items.length)
        touchX.current = null
      }}
    >
      <button className="close" onClick={onClose} aria-label="Закрыть">✕</button>
      <button className="arrow prev" onClick={() => onNav((index - 1 + items.length) % items.length)} aria-label="Назад">‹</button>
      <img src={item.src} alt={item.alt ?? ''} />
      <button className="arrow next" onClick={() => onNav((index + 1) % items.length)} aria-label="Вперёд">›</button>
      <div className="counter">{index + 1} / {items.length}{item.caption ? ` · ${item.caption}` : ''}</div>
    </div>
  )
}

// Кнопка для асинхронных действий: на время запроса показывает спиннер и
// блокируется; ошибка API всплывает тостом. Успех вызывающий код сообщает
// сам через toast() — текст успеха у каждого действия свой.
export function AsyncButton({
  onClick,
  children,
  className = 'btn btn-sm',
  busyLabel = 'Сохраняем…',
  title,
}: {
  onClick: () => Promise<unknown>
  children: ReactNode
  className?: string
  busyLabel?: string
  title?: string
}) {
  const [busy, setBusy] = useState(false)
  async function handle() {
    if (busy) return
    setBusy(true)
    try {
      await onClick()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button className={className} onClick={handle} disabled={busy} title={title}>
      {busy && <span className="spinner-inline" aria-hidden="true" />}
      {busy ? busyLabel : children}
    </button>
  )
}

// Стилизованная замена системного confirm(): Escape и клик по фону = отмена,
// фокус по умолчанию на «Отмене» — безопаснее для необратимых действий.
export function ConfirmDialog({
  open,
  title,
  text,
  confirmLabel = 'Удалить',
  cancelLabel = 'Отмена',
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  text?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginBottom: 8 }}>{title}</h3>
        {text && <p className="small muted" style={{ margin: 0 }}>{text}</p>}
        <div className="chips" style={{ justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-sm" autoFocus onClick={onCancel}>{cancelLabel}</button>
          <button className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
