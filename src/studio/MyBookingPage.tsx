import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { backend as be, type BookingRecord, type StudioBundle } from '@/backend'
import { canCancelByPolicy } from '@/core/availability'
import { Empty, ErrorBox, Section, Spinner, StatusBadge, ConfirmDialog } from '@/ui/common'
import { humanDate, money, timeInTz } from '@/ui/format'
import { downloadIcs } from '@/lib/ics'
import { listBookings, removeBooking } from './bookingStorage'

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

function Details({ b, bundle, token }: { b: BookingRecord; bundle: StudioBundle; token: string }) {
  const done = indexOfStatus(b.status)
  const closed = ['cancelled_by_client', 'rejected', 'no_show'].includes(b.status)
  const cancel = canCancelByPolicy({
    startsAtMs: b.startsAtMs,
    freeHours: bundle.settings.cancellation.freeHours,
    nowMs: Date.now(),
    status: b.status,
  })
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [askCancel, setAskCancel] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const qc = useQueryClient()
  const navigate = useNavigate()

  async function doCancel() {
    if (cancelBusy) return
    setCancelBusy(true)
    // секрет берём из ссылки (в теле ответа сервер его не возвращает)
    const res = await be.cancelMyBooking(bundle.settings.slug, token)
    if (res.ok) {
      // удаляем из localStorage именно отменённую запись (токен из ссылки),
      // а не «самую свежую» как clearLastToken
      removeBooking(bundle.settings.slug, token)
      qc.invalidateQueries()
      navigate(`/s/${bundle.settings.slug}/my`)
    } else {
      setCancelError(res.error ?? 'Не удалось отменить')
      setCancelBusy(false)
    }
  }

  return (
    <div>
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
          <button className="btn" disabled={!cancel.allowed || cancelBusy} onClick={() => setAskCancel(true)} title={cancel.reason}>
            {cancelBusy ? <><span className="spinner-inline" aria-hidden="true" /> Отменяем…</> : cancel.allowed ? 'Отменить запись' : `Отмена недоступна (${cancel.reason})`}
          </button>
        </div>
      )}

      <ConfirmDialog
        open={askCancel}
        title="Отменить запись?"
        text="Время освободится для других клиентов. Вернуть запись нельзя — придётся бронировать заново."
        confirmLabel="Да, отменить запись"
        onConfirm={() => {
          setAskCancel(false)
          void doCancel()
        }}
        onCancel={() => setAskCancel(false)}
      />

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
  const tokens = listBookings(slug || bundle.settings.slug).map((x) => x.token)
  const token = routeToken ?? tokens[0] ?? null

  const { data, isLoading, error } = useQuery({
    queryKey: ['my', slug, token],
    queryFn: () => be.getMyBooking(bundle.settings.slug, token!),
    enabled: Boolean(token),
    refetchInterval: 60_000,
  })

  // Список всех записей с этого устройства (страница без токена в URL)
  const [listTick, setListTick] = useState(0)
  const stored = listBookings(slug || bundle.settings.slug)
  const listQuery = useQuery({
    queryKey: ['my-list', slug, stored.map((x) => x.token).join(','), listTick],
    queryFn: async () => {
      const pairs = await Promise.all(
        stored.map((s) => be.getMyBooking(bundle.settings.slug, s.token).then((r) => (r ? { ...r, token: s.token } : null)))
      )
      return pairs.filter((r): r is BookingRecord => r !== null)
    },
    enabled: !routeToken && stored.length > 0,
    refetchInterval: 60_000,
  })

  if (routeToken || (token && stored.length <= 1)) {
    return (
      <Section>
        <div style={{ maxWidth: 560, marginInline: 'auto' }}>
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
          {token && data && (
            <>
              {stored.length > 1 && (
                <p className="small" style={{ marginBottom: 14 }}>
                  <Link to={`/s/${bundle.settings.slug}/my`}>← Все мои записи ({stored.length})</Link>
                </p>
              )}
              <Details b={data} bundle={bundle} token={token} />
            </>
          )}
        </div>
      </Section>
    )
  }

  const records = listQuery.data ?? []
  const active = records.filter((b) => !['cancelled_by_client', 'rejected', 'no_show', 'completed'].includes(b.status))
  const closed = records.filter((b) => ['cancelled_by_client', 'rejected', 'no_show', 'completed'].includes(b.status))

  return (
    <Section>
      <div style={{ maxWidth: 560, marginInline: 'auto' }}>
        <div className="overline">{bundle.settings.name}</div>
        <h2>Мои записи</h2>
        {stored.length === 0 && (
          <Empty>
            Записей с этого устройства нет. <Link to={`/s/${bundle.settings.slug}/book`}>Записаться</Link>
          </Empty>
        )}
        {stored.length > 0 && listQuery.isLoading && <Spinner />}
        {stored.length > 0 && !listQuery.isLoading && records.length === 0 && (
          <Empty>Ссылки устарели — старые записи недоступны</Empty>
        )}
        {[...active, ...closed].map((b) => {
          const dimmed = closed.includes(b)
          return (
            <div className="card booking-row" key={b.id} style={{ marginBottom: 10, opacity: dimmed ? 0.6 : 1 }}>
              <div>
                <strong>{b.serviceName}</strong>
                <div className="small muted">
                  {humanDate(bundle.settings.tz, b.startsAtMs)}, {timeInTz(bundle.settings.tz, b.startsAtMs)} · {money(b.price.total)}
                </div>
              </div>
              <div className="chips">
                <StatusBadge status={b.status} />
                <Link className="chip" to={`/s/${bundle.settings.slug}/my/${b.token || ''}`}>Открыть</Link>
                <button
                  className="chip"
                  title="Убрать из списка на этом устройстве"
                  onClick={() => {
                    removeBooking(bundle.settings.slug, b.token)
                    setListTick((n) => n + 1)
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          )
        })}
        <Link className="btn btn-primary" to={`/s/${bundle.settings.slug}/book`} style={{ marginTop: 8 }}>
          Записаться ещё
        </Link>
      </div>
    </Section>
  )
}
