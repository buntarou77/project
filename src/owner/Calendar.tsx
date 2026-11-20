import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { backend as be, type BookingRecord, type StudioBundle } from '@/backend'
import { Section, Spinner, StatusBadge } from '@/ui/common'
import { humanDate, timeInTz, WEEKDAY_RU, endInTz } from '@/ui/format'
import { addDaysToDateString, utcToZonedDate } from '@/core/time'

type View = 'day' | 'week' | 'month'

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function shiftMonth(date: string, months: number): string {
  const [y, m] = date.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + months, 1))
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

  // П6: −1 день — ночная бронь, начавшаяся накануне, занимает первый день
  // диапазона; byDay (Z3) разложит её по дням занятия корректно
  const { data, isLoading } = useQuery({
    queryKey: ['owner-cal', slug, shiftDate(range.from, -1), range.to],
    queryFn: () => be.ownerBookings(slug, { dateFrom: shiftDate(range.from, -1), dateTo: range.to }),
  })

  const byDay = useMemo(() => {
    // Z3: бронь попадает во ВСЕ дни, которые занимает: ночная пн 22:00–вт 06:00
    // видна и в понедельник, и во вторник (раньше — только в день старта)
    const map = new Map<string, BookingRecord[]>()
    for (const b of data ?? []) {
      let d = utcToZonedDate(bundle.settings.tz, b.startsAtMs)
      const end = utcToZonedDate(bundle.settings.tz, b.endsAtMs)
      let guard = 0
      while (guard++ < 30) {
        map.set(d, [...(map.get(d) ?? []), b])
        if (d >= end) break
        d = addDaysToDateString(d, 1)
      }
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
        <button className="chip" onClick={() => setAnchor(shiftUnit(anchor, view, -1))}>←</button>
        <button className="chip" onClick={() => setAnchor(new Date().toISOString().slice(0, 10))} title="Вернуться к сегодня">Сегодня</button>
        <button className="chip" onClick={() => setAnchor(shiftUnit(anchor, view, 1))}>→</button>
      </div>
      {isLoading && <Spinner />}
      <div className={view === 'month' ? 'cal-grid' : 'grid'} style={view === 'month' ? {} : { gridTemplateColumns: `repeat(${days.length}, minmax(130px, 1fr))` }}>
        {days.map((d, i) => {
          const list = d ? byDay.get(d) ?? [] : []
          const wd = d ? WEEKDAY_RU[weekday(d)] : ''
          const closed = d ? bundle.settings.closedDates.includes(d) : false
          return (
            <div
              className="cal-cell"
              key={i}
              style={{
                ...(d ? {} : { visibility: 'hidden' }),
                ...(closed ? { background: 'color-mix(in srgb, var(--bad) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--bad) 35%, transparent)' } : {}),
              }}
              title={closed ? 'Закрытая дата' : undefined}
            >
              <div className="small" style={{ fontWeight: 700 }}>{d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : ''}</div>
              {d && <div className="muted" style={{ fontSize: '0.68rem' }}>{wd}{closed ? ' · закрыто' : ''}</div>}
              {list.map((b) => (
                <div key={b.id} style={{ marginTop: 6 }}>
                  <div className="small" style={{ fontWeight: 600 }}>{timeInTz(bundle.settings.tz, b.startsAtMs)}–{endInTz(bundle.settings.tz, b.startsAtMs, b.endsAtMs)} {b.serviceName}</div>
                  <div className="muted" style={{ fontSize: '0.7rem' }}>{b.client.name}</div>
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

// шаг навигации по viewType: день — сутки, неделя — 7 дней, месяц — календарный месяц
function shiftUnit(anchor: string, view: View, dir: 1 | -1): string {
  if (view === 'month') return shiftMonth(anchor, dir)
  return shiftDate(anchor, dir * (view === 'week' ? 7 : 1))
}

function weekday(d: string): string {
  const keys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
  return keys[(new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7]
}
