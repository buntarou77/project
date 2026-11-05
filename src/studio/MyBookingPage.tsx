import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { backend as be, type BookingRecord, type StudioBundle } from '@/backend'
import { canCancelByPolicy } from '@/core/availability'
import { Empty, ErrorBox, Section, Spinner, StatusBadge } from '@/ui/common'
import { humanDate, money, timeInTz } from '@/ui/format'
import { downloadIcs } from '@/lib/ics'
import { clearLastToken, getLastToken } from './bookingStorage'

const TIMELINE: { key: string; label: string }[] = [
  { key: 'new', label: 'Заявка отправлена' },
  { key: 'confirmed', label: 'Подтверждена владельцем' },
  { key: 'prepaid', label: 'Предоплата получена' },
  { key: 'shot_done', label: 'Съёмка проведена' },
  { key: 'processing', label: 'Материалы в обработке' },
  { key: 'delivered', label: 'Материалы сданы' },
  { key: 'completed', label: 'Завершена' },
]

function indexOfStatus(status: BookingRecord['status']): number {
  return TIMELINE.findIndex((t) => t.key === status)
}

function Details({ b, bundle }: { b: BookingRecord; bundle: StudioBundle }) {
  const done = indexOfStatus(b.status)
  const closed = ['cancelled_by_client', 'rejected', 'no_show'].includes(b.status)
  const cancel = canCancelByPolicy({
    startsAtMs: b.startsAtMs,
    freeHours: bundle.settings.cancellation.freeHours,
    nowMs: Date.now(),
    status: b.status,
  })
  const [cancelError, setCancelError] = useState<string | null>(null)
  const qc = useQueryClient()
  const navigate = useNavigate()

  async function doCancel() {
    if (!confirm('Отменить запись?')) return
    const res = await be.cancelMyBooking(bundle.settings.slug, b.token)
    if (res.ok) {
      clearLastToken(bundle.settings.slug)
      qc.invalidateQueries()
      navigate(`/s/${bundle.settings.slug}/my`)
    } else setCancelError(res.error ?? 'Не удалось отменить')
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="booking-row">
          <h3 style={{ margin: 0 }}>{b.serviceName}</h3>
          <StatusBadge status={b.status} />
        </div>
        <div className="sum-row" style={{ marginTop: 12 }}><span className="muted">Когда</span><span>{humanDate(bundle.settings.tz, b.startsAtMs)}, {timeInTz(bundle.settings.tz, b.startsAtMs)}</span></div>
        {b.client.people && <div className="sum-row"><span className="muted">Человек</span><span>{b.client.people}</span></div>}
        <div className="sum-row"><span className="muted">Стоимость</span><span>{money(b.price.total)}</span></div>
        {b.price.prepayment > 0 && <div className="sum-row"><span className="muted">Предоплата</span><span>{money(b.price.prepayment)}</span></div>}
        {b.paidTotal > 0 && <div className="sum-row"><span className="muted">Оплачено</span><span>{money(b.paidTotal)}</span></div>}
        {b.client.notes && <p className="small muted" style={{ marginBottom: 0 }}>Пожелания: {b.client.notes}</p>}
      </div>

      {!closed && (
        <div className="card" style={{ marginBottom: 18 }}>
          <ul className="timeline">
            {TIMELINE.map((t, i) => (
              <li key={t.key} className={i <= done ? 'done' : ''}>{t.label}</li>
            ))}
          </ul>
        </div>
      )}

      {b.deliverablesUrl && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h3>Готовые материалы</h3>
          <a className="btn btn-primary" href={b.deliverablesUrl} target="_blank" rel="noopener noreferrer">Открыть галерею</a>
        </div>
      )}

      {!closed && (
        <div className="card">
          <div className="overline">Отмена</div>
          <p className="small">{bundle.settings.cancellation.text}</p>
          {cancelError && <ErrorBox>{cancelError}</ErrorBox>}
          <button className="btn" disabled={!cancel.allowed} onClick={doCancel} title={cancel.reason}>
            {cancel.allowed ? 'Отменить запись' : `Отмена недоступна (${cancel.reason})`}
          </button>
        </div>
      )}

      {!closed && b.status !== 'new' && (
        <button
          className="chip"
          style={{ marginTop: 16 }}
          onClick={() =>
            downloadIcs('zapis.ics', {
              title: `${b.serviceName} — ${bundle.settings.name}`,
              startMs: b.startsAtMs,
              endMs: b.endsAtMs,
              location: bundle.settings.address,
            })
          }
        >
          Добавить в календарь (.ics)
        </button>
      )}
    </div>
  )
}

export default function MyBookingPage({ bundle }: { bundle: StudioBundle }) {
  const { slug = '', token: routeToken } = useParams()
  const stored = getLastToken(slug || bundle.settings.slug)
  const token = routeToken ?? stored

  const { data, isLoading, error } = useQuery({
    queryKey: ['my', slug, token],
    queryFn: () => be.getMyBooking(bundle.settings.slug, token!),
    enabled: Boolean(token),
    refetchInterval: 60_000,
  })

  return (
    <Section>
      <div className="overline">{bundle.settings.name}</div>
      <h2>Моя запись</h2>
      {!token && (
        <Empty>
          Активной записи не найдено. <Link to={`/s/${bundle.settings.slug}/book`}>Записаться</Link>
        </Empty>
      )}
      {token && isLoading && <Spinner />}
      {token && error && <ErrorBox>Не удалось загрузить запись</ErrorBox>}
      {token && data === null && <Empty>Запись не найдена или ссылка устарела</Empty>}
      {token && data && <Details b={data} bundle={bundle} />}
    </Section>
  )
}
