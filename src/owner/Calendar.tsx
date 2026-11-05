import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { backend as be, type BookingRecord, type StudioBundle } from '@/backend'
import { Section, Spinner, StatusBadge } from '@/ui/common'
import { humanDate, timeInTz, WEEKDAY_RU } from '@/ui/format'
import { utcToZonedDate } from '@/core/time'

type View = 'day' | 'week' | 'month'

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export default function OwnerCalendar({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const [view, setView] = useState<View>('week')
  const [anchor, setAnchor] = useState(() => new Date().toISOString().slice(0, 10))

  const days = useMemo(() => {
    if (view === 'day') return [anchor]
    if (view === 'week') {
      const d = new Date(anchor + 'T00:00:00Z')
      const dow = (d.getUTCDay() + 6) % 7
      const monday = shiftDate(anchor, -dow)
      return Array.from({ length: 7 }, (_, i) => shiftDate(monday, i))
    }
    const [y, m] = anchor.split('-').map(Number)
    const first = new Date(Date.UTC(y, m - 1, 1))
    const total = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const pad = Math.max(0, (first.getUTCDay() + 6) % 7)
    return [...Array.from({ length: pad }, () => ''), ...Array.from({ length: total }, (_, i) => `${anchor.slice(0, 7)}-${String(i + 1).padStart(2, '0')}`)]
  }, [view, anchor])

  const range = useMemo(() => {
    const real = days.filter(Boolean)
    return { from: real[0] ?? anchor, to: real[real.length - 1] ?? anchor }
  }, [days, anchor])

  const { data, isLoading } = useQuery({
    queryKey: ['owner-cal', slug, range.from, range.to],
    queryFn: () => be.ownerBookings(slug, { dateFrom: range.from, dateTo: range.to }),
  })

  const byDay = useMemo(() => {
    const map = new Map<string, BookingRecord[]>()
    for (const b of data ?? []) {
      const d = utcToZonedDate(bundle.settings.tz, b.startsAtMs)
      map.set(d, [...(map.get(d) ?? []), b])
    }
    return map
  }, [data, bundle.settings.tz])

  return (
    <Section>
      <div className="filters">
        <select value={view} onChange={(e) => setView(e.target.value as View)}>
          <option value="day">День</option>
          <option value="week">Неделя</option>
          <option value="month">Месяц</option>
        </select>
        <input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
        <button className="chip" onClick={() => setAnchor(shiftDate(anchor, view === 'month' ? 30 : view === 'week' ? 7 : 1))}>→</button>
        <button className="chip" onClick={() => setAnchor(shiftDate(anchor, view === 'month' ? -30 : view === 'week' ? -7 : -1))}>←</button>
      </div>
      {isLoading && <Spinner />}
      <div className={view === 'month' ? 'cal-grid' : 'grid'} style={view === 'month' ? {} : { gridTemplateColumns: `repeat(${days.length}, minmax(130px, 1fr))` }}>
        {days.map((d, i) => {
          const list = d ? byDay.get(d) ?? [] : []
          const wd = d ? WEEKDAY_RU[weekday(d)] : ''
          return (
            <div className="cal-cell" key={i} style={!d ? { visibility: 'hidden' } : undefined}>
              <div className="small" style={{ fontWeight: 700 }}>{d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : ''}</div>
              {d && <div className="muted" style={{ fontSize: '0.68rem' }}>{wd}</div>}
              {list.map((b) => (
                <div key={b.id} style={{ marginTop: 6 }}>
                  <div className="small" style={{ fontWeight: 600 }}>{timeInTz(bundle.settings.tz, b.startsAtMs)} {b.serviceName}</div>
                  <StatusBadge status={b.status} />
                </div>
              ))}
            </div>
          )
        })}
      </div>
      <p className="small muted">Часовой пояс студии: {bundle.settings.tz}. Сегодня: {humanDate(bundle.settings.tz, Date.now())}</p>
    </Section>
  )
}

function weekday(d: string): string {
  const keys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  return keys[(new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7]
}
