import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { ErrorBox, Section, Spinner } from '@/ui/common'
import { money } from '@/ui/format'
import { utcToZonedDate, zonedToUtcMs } from '@/core/time'
import { weekdayKeyOfDate, addDaysToDateString, windowDurationMin } from '@/core/time'

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

  const { data, isLoading, isError, refetch } = useQuery({
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
    // Z3: «реально получено» — без отменённых/неявок: их paidTotal — возврат
    const moneyIn = inPeriodByStart
      .filter((b) => !['cancelled_by_client', 'rejected', 'no_show'].includes(b.status))
      .reduce((s, b) => s + b.paidTotal, 0)

    // B-86: загрузка залов — числитель это пересечение интервала брони с
    // рабочими окнами дней И границами периода; знаменатель — ёмкость графика
    // за дни периода до сегодня минус закрытые даты
    const closedDates = new Set(bundle.settings.closedDates)
    const tz = bundle.settings.tz
    const today = utcToZonedDate(tz, now)
    const hallHours = new Map<string, number>()
    let capacityHours = 0
    // нижняя граница: окно периода; «всё время» — от первой брони
    const periodStartMs = periodMs > 0 ? now - periodMs : list.length ? Math.min(...list.map((b) => b.startsAtMs)) : now
    let cursor = utcToZonedDate(tz, periodStartMs)
    let guard = 0
    while (cursor <= today && guard < 3650) {
      if (!closedDates.has(cursor)) {
        const win = bundle.settings.schedule[weekdayKeyOfDate(cursor)]
        if (win) capacityHours += windowDurationMin(win.open, win.close) / 60
      }
      cursor = addDaysToDateString(cursor, 1)
      guard++
    }
    for (const b of list) {
      if (!b.hallId) continue
      // B-86: отменённые/отклонённые/неявки зал не занимали — в числитель
      // загрузки не попадают; completed — отработанная заявка, учитывается
      if (['cancelled_by_client', 'rejected', 'no_show'].includes(b.status)) continue
      // бронь обрезаем до границ периода и до «сейчас» — будущее не считается
      const from = Math.max(b.startsAtMs, periodStartMs)
      const to = Math.min(b.endsAtMs, now)
      if (from >= to) continue
      // идём по дням брони в tz студии: ночная смена занимает и следующий день
      let d = utcToZonedDate(tz, from)
      const lastDay = utcToZonedDate(tz, to - 1)
      let busyMs = 0
      let dayGuard = 0
      while (dayGuard++ < 60) {
        const win = bundle.settings.schedule[weekdayKeyOfDate(d)]
        if (win) {
          const winStart = zonedToUtcMs(tz, d, win.open)
          const winEnd = winStart + windowDurationMin(win.open, win.close) * 60_000
          const s = Math.max(from, winStart)
          const e = Math.min(to, winEnd)
          if (s < e) busyMs += e - s
        }
        if (d >= lastDay) break
        d = addDaysToDateString(d, 1)
      }
      hallHours.set(b.hallId, (hallHours.get(b.hallId) ?? 0) + busyMs / 3_600_000)
    }
    const loadRows = bundle.halls.map((h) => ({
      hall: h.name,
      hours: hallHours.get(h.id) ?? 0,
      // R2: без рабочих часов делить нельзя — 0/0 давало NaN в UI
      load: capacityHours > 0 ? Math.min(100, Math.round(((hallHours.get(h.id) ?? 0) / capacityHours) * 100)) : null,
    }))
    return { leads, conversion, shotDone, revenueActive, moneyIn, loadRows }
  }, [data, bundle.halls, bundle.settings.schedule, bundle.settings.closedDates, bundle.settings.tz, periodMs])

  if (isLoading) return <Spinner />
  // B-82: сбой загрузки не должен выглядеть как нули в статистике;
  // фоновый сбой при уже загруженных данных данные не заменяет
  if (isError && !data) {
    return (
      <Section>
        <ErrorBox>
          Не удалось загрузить статистику.{' '}
          <button className="btn btn-sm" onClick={() => refetch()}>Повторить</button>
        </ErrorBox>
      </Section>
    )
  }

  return (
    <Section>
      {/* B-82: фоновый сбой при показанных данных — предупреждаем об устаревании */}
      {isError && data && (
        <ErrorBox>
          Данные могли устареть.{' '}
          <button className="btn btn-sm" onClick={() => refetch()}>Обновить</button>
        </ErrorBox>
      )}
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
                <span className="muted small">{r.hours.toFixed(0)} ч · {r.load === null ? 'нет данных' : `~${r.load}%`}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="small muted">Данные студии: {bundle.settings.name} ({utcToZonedDate(bundle.settings.tz, Date.now())} по её времени). Загрузка — от рабочих часов графика студии.</p>
    </Section>
  )
}
