import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { Empty, Section, Spinner } from '@/ui/common'
import { humanDate, money, timeInTz } from '@/ui/format'
import { dateInTz } from '@/ui/format'

export default function Deliveries({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
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

  async function setUrl(id: string, current: string) {
    const url = prompt('Ссылка на готовые материалы', current)
    if (url === null) return
    await be.ownerUpdateBooking(slug, id, { deliverablesUrl: url, status: 'delivered' })
    location.reload()
  }

  return (
    <Section>
      <h2>Ждут сдачи материалов</h2>
      {isLoading && <Spinner />}
      {waiting.length === 0 && !isLoading && <Empty>Всё сдано — пусто</Empty>}
      {waiting.map(({ b, deadlineMs, overdue }) => (
        <div className="card" key={b.id} style={{ marginBottom: 10 }}>
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
            <button className="btn btn-sm" onClick={() => setUrl(b.id, b.deliverablesUrl ?? '')}>
              {b.deliverablesUrl ? 'Обновить ссылку' : 'Отметить сданной'}
            </button>
          </div>
        </div>
      ))}
      <p className="small muted">Подтверждённая выручка по сданным: {money(waiting.filter((w) => w.b.status === 'delivered').reduce((s, w) => s + w.b.price.total, 0))}</p>
    </Section>
  )
}
