import { useEffect, useRef, type ReactNode } from 'react'
import type { BookingStatus } from '@/backend/types'
import { STATUS_LABELS } from '@/backend/types'

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
