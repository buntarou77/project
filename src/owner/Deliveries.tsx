import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { backend as be, type BookingRecord, type StudioBundle } from '@/backend'
import { AsyncButton, Empty, Section, Spinner } from '@/ui/common'
import { humanDate, money, timeInTz } from '@/ui/format'
import { dateInTz } from '@/ui/format'
import { toast, toastError } from '@/ui/toast'

function DeliveryCard({
  b,
  deadlineMs,
  overdue,
  bundle,
  slug,
  onChanged,
}: {
  b: BookingRecord
  deadlineMs: number
  overdue: boolean
  bundle: StudioBundle
  slug: string
  onChanged: () => void
}) {
  const [url, setUrl] = useState(b.deliverablesUrl ?? '')

  async function save(status: 'delivered' | 'processing') {
    try {
      await be.ownerUpdateBooking(slug, b.id, { deliverablesUrl: url || undefined, status })
      onChanged()
      toast(status === 'delivered' ? 'Отмечено сданным' : 'Возвращено в работу')
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="booking-row">
        <div>
          <strong>{b.serviceName}</strong>
          <div className="small muted">
            Съёмка: {humanDate(bundle.settings.tz, b.startsAtMs)}, {timeInTz(bundle.settings.tz, b.startsAtMs)} · {b.client.name}
          </div>
          <div className="small" style={{ color: overdue ? 'var(--bad)' : 'var(--muted)' }}>
            Дедлайн: {dateInTz(bundle.settings.tz, deadlineMs)} {overdue ? '· ПРОСРОЧЕНО' : ''}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 12 }}>
        <div className="field" style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
          <label>Ссылка на материалы</label>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </div>
        {b.status !== 'delivered' ? (
          <AsyncButton className="btn btn-sm btn-primary" busyLabel="Сохраняем…" onClick={() => save('delivered')}>
            Отметить сданной
          </AsyncButton>
        ) : (
          <AsyncButton className="btn btn-sm" busyLabel="Возвращаем…" onClick={() => save('processing')}>
            Вернуть в работу
          </AsyncButton>
        )}
      </div>
    </div>
  )
}

export default function Deliveries({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['owner-deliveries', slug],
    queryFn: () => be.ownerBookings(slug, { status: 'all' }),
  })

  const waiting = useMemo(() => {
    return (data ?? [])
      .filter((b) => ['shot_done', 'processing', 'delivered'].includes(b.status))
      .map((b) => {
        const service = bundle.services.find((s) => s.id === b.serviceId)
        const deadlineMs = b.startsAtMs + (service?.deadlineDays ?? 7) * 86_400_000
        const overdue = Date.now() > deadlineMs && b.status !== 'delivered'
        return { b, deadlineMs, overdue }
      })
      .sort((x, y) => x.deadlineMs - y.deadlineMs)
  }, [data, bundle.services])

  function onChanged() {
    qc.invalidateQueries({ queryKey: ['owner-deliveries', slug] })
    qc.invalidateQueries({ queryKey: ['owner-bookings'] })
  }

  return (
    <Section>
      <h2>Ждут сдачи материалов</h2>
      {isLoading && <Spinner />}
      {waiting.length === 0 && !isLoading && <Empty>Всё сдано — пусто</Empty>}
      {waiting.map(({ b, deadlineMs, overdue }) => (
        <DeliveryCard key={b.id} b={b} deadlineMs={deadlineMs} overdue={overdue} bundle={bundle} slug={slug} onChanged={onChanged} />
      ))}
      <p className="small muted">Подтверждённая выручка по сданным: {money(waiting.filter((w) => w.b.status === 'delivered').reduce((s, w) => s + w.b.price.total, 0))}</p>
    </Section>
  )
}
