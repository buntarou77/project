import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { Section, Spinner } from '@/ui/common'
import { money } from '@/ui/format'
import { utcToZonedDate } from '@/core/time'

export default function Stats({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['owner-stats', slug],
    queryFn: () => be.ownerBookings(slug, { status: 'all' }),
  })

  const stats = useMemo(() => {
    const list = data ?? []
    const monthAgo = Date.now() - 30 * 86_400_000
    const recent = list.filter((b) => b.createdAtMs >= monthAgo)
    const leads = recent.length
    const confirmed = recent.filter((b) => ['confirmed', 'prepaid', 'shot_done', 'processing', 'delivered', 'completed'].includes(b.status))
    const conversion = leads ? Math.round((confirmed.length / leads) * 100) : 0
    const shotDone = recent.filter((b) => ['shot_done', 'processing', 'delivered', 'completed'].includes(b.status)).length
    const revenueActive = list
      .filter((b) => !['cancelled_by_client', 'rejected', 'no_show'].includes(b.status))
      .reduce((s, b) => s + b.price.total, 0)
    const moneyIn = list.reduce((s, b) => s + b.paidTotal, 0)

    const hallHours = new Map<string, number>()
    for (const b of list) {
      if (!b.hallId || b.startsAtMs < monthAgo) continue
      hallHours.set(b.hallId, (hallHours.get(b.hallId) ?? 0) + (b.endsAtMs - b.startsAtMs) / 3_600_000)
    }
    const loadRows = bundle.halls.map((h) => ({
      hall: h.name,
      hours: hallHours.get(h.id) ?? 0,
      // приближение: 11 рабочих часов × 30 дней
      load: Math.min(100, Math.round(((hallHours.get(h.id) ?? 0) / (11 * 30)) * 100)),
    }))
    return { leads, conversion, shotDone, revenueActive, moneyIn, loadRows }
  }, [data, bundle.halls])

  if (isLoading) return <Spinner />

  return (
    <Section>
      <h2>Статистика за 30 дней</h2>
      <div className="grid grid-3">
        <div className="card"><div className="overline">Заявки</div><div className="kpi">{stats.leads}</div><p className="small muted" style={{ margin: 0 }}>конверсия в подтверждение: {stats.conversion}%</p></div>
        <div className="card"><div className="overline">Съёмок проведено</div><div className="kpi">{stats.shotDone}</div></div>
        <div className="card"><div className="overline">Подтверждённая выручка</div><div className="kpi">{money(stats.revenueActive)}</div><p className="small muted" style={{ margin: 0 }}>реально получено: {money(stats.moneyIn)}</p></div>
      </div>
      {stats.loadRows.length > 0 && (
        <>
          <h3 style={{ marginTop: 22 }}>Загрузка залов (30 дней)</h3>
          <div className="card">
            {stats.loadRows.map((r) => (
              <div key={r.hall} className="sum-row">
                <span>{r.hall}</span>
                <span className="muted small">{r.hours.toFixed(0)} ч · ~{r.load}%</span>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="small muted">Данные студии: {bundle.settings.name} ({utcToZonedDate(bundle.settings.tz, Date.now())} по её времени)</p>
    </Section>
  )
}
