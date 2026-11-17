import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { Section, Spinner } from '@/ui/common'
import { money } from '@/ui/format'
import { utcToZonedDate } from '@/core/time'
import { minutesOf, weekdayKeyOfDate, addDaysToDateString } from '@/core/time'

const PERIODS: [string, string, number][] = [
  ['30', '30 дней', 30],
  ['90', '90 дней', 90],
  ['365', 'Год', 365],
  ['all', 'Всё время', 0],
]

export default function Stats({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const [period, setPeriod] = useState('30')
  const days = PERIODS.find((p) => p[0] === period)![2]
  const periodMs = days > 0 ? days * 86_400_000 : 0
  const periodLabel = PERIODS.find((p) => p[0] === period)![1]

  const { data, isLoading } = useQuery({
    queryKey: ['owner-stats', slug],
    queryFn: () => be.ownerBookings(slug, { status: 'all' }),
  })

  const stats = useMemo(() => {
    const list = data ?? []
    const now = Date.now()
    const inPeriod = (ms: number) => (periodMs > 0 ? ms >= now - periodMs : true)
    const recent = list.filter((b) => inPeriod(b.createdAtMs))
    const leads = recent.length
    const confirmed = recent.filter((b) => ['confirmed', 'prepaid', 'shot_done', 'processing', 'delivered', 'completed'].includes(b.status))
    const conversion = leads ? Math.round((confirmed.length / leads) * 100) : 0
    const shotDone = recent.filter((b) => ['shot_done', 'processing', 'delivered', 'completed'].includes(b.status)).length
    // выручка считаем за тот же период (по дате съёмки), а не «за всё время»
    const inPeriodByStart = list.filter((b) => inPeriod(b.startsAtMs))
    const revenueActive = inPeriodByStart
      .filter((b) => !['cancelled_by_client', 'rejected', 'no_show'].includes(b.status))
      .reduce((s, b) => s + b.price.total, 0)
    const moneyIn = inPeriodByStart.reduce((s, b) => s + b.paidTotal, 0)

    // ёмкость зала — из реального графика студии, а не «11 часов»
    const hallHours = new Map<string, number>()
    let capacityHours = 0
    if (periodMs > 0) {
      let cursor = new Date(now - periodMs).toISOString().slice(0, 10)
      const today = new Date(now).toISOString().slice(0, 10)
      let guard = 0
      while (cursor <= today && guard < 800) {
        const win = bundle.settings.schedule[weekdayKeyOfDate(cursor)]
        if (win) capacityHours += (minutesOf(win.close) - minutesOf(win.open)) / 60
        cursor = addDaysToDateString(cursor, 1)
        guard++
      }
    }
    if (capacityHours === 0) capacityHours = 11 * 30 // всё время: ориентир
    for (const b of list) {
      if (!b.hallId || !inPeriod(b.startsAtMs)) continue
      hallHours.set(b.hallId, (hallHours.get(b.hallId) ?? 0) + (b.endsAtMs - b.startsAtMs) / 3_600_000)
    }
    const loadRows = bundle.halls.map((h) => ({
      hall: h.name,
      hours: hallHours.get(h.id) ?? 0,
      load: Math.min(100, Math.round(((hallHours.get(h.id) ?? 0) / capacityHours) * 100)),
    }))
    return { leads, conversion, shotDone, revenueActive, moneyIn, loadRows }
  }, [data, bundle.halls, bundle.settings.schedule, periodMs])

  if (isLoading) return <Spinner />

  return (
    <Section>
      <div className="filters" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Статистика: {periodLabel.toLowerCase()}</h2>
        <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          {PERIODS.map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
      </div>
      <div className="grid grid-3">
        <div className="card"><div className="overline">Заявки</div><div className="kpi">{stats.leads}</div><p className="small muted" style={{ margin: 0 }}>конверсия в подтверждение: {stats.conversion}%</p></div>
        <div className="card"><div className="overline">Съёмок проведено</div><div className="kpi">{stats.shotDone}</div></div>
        <div className="card"><div className="overline">Подтверждённая выручка</div><div className="kpi">{money(stats.revenueActive)}</div><p className="small muted" style={{ margin: 0 }}>реально получено: {money(stats.moneyIn)}</p></div>
      </div>
      {stats.loadRows.length > 0 && (
        <>
          <h3 style={{ marginTop: 22 }}>Загрузка залов ({periodLabel.toLowerCase()})</h3>
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
      <p className="small muted">Данные студии: {bundle.settings.name} ({utcToZonedDate(bundle.settings.tz, Date.now())} по её времени). Загрузка — от рабочих часов графика студии.</p>
    </Section>
  )
}
