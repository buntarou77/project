import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { backend as be, type BookingFilters, type BookingRecord, type StudioBundle, STATUS_LABELS, BOOKING_STATUSES } from '@/backend'
import { Empty, ErrorBox, Section, Spinner, StatusBadge } from '@/ui/common'
import { humanDate, money, timeInTz } from '@/ui/format'
import { contactHref, CONTACT_LABELS } from '@/lib/links'
import { downloadCsv } from '@/lib/csv'
import { zonedToUtcMs } from '@/core/time'

function ManualAdd({ bundle, slug, onDone }: { bundle: StudioBundle; slug: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    serviceId: bundle.services[0]?.id ?? '',
    specialistId: bundle.specialists[0]?.id ?? '',
    hallId: bundle.halls[0]?.id ?? '',
    when: '',
    hours: 1,
    name: '',
    phone: '',
  })
  const service = bundle.services.find((s) => s.id === form.serviceId)

  async function save() {
    if (!service || !form.when) return
    const startMs = zonedToUtcMs(bundle.settings.tz, form.when.slice(0, 10), form.when.slice(11, 16))
    const durationMin = service.priceType === 'hourly' ? form.hours * 60 : service.durationMin
    await be.ownerCreateBookingManual(slug, {
      slug,
      kind: service.kind,
      serviceId: service.id,
      serviceName: service.name,
      specialistId: service.needsSpecialist ? form.specialistId || null : null,
      hallId: service.needsHall ? form.hallId || null : null,
      startsAtMs: startMs,
      endsAtMs: startMs + durationMin * 60_000,
      allDay: service.fullDay,
      dayCount: 1,
      status: 'confirmed',
      client: { name: form.name || 'Клиент', phone: form.phone || '—', method: 'phone' },
      price: {
        lines: [{ label: service.name, amount: service.priceType === 'fixed' ? service.price : service.price * form.hours }],
        total: service.priceType === 'fixed' ? service.price : service.price * form.hours,
        prepayment: 0,
      },
      paidTotal: 0,
      source: 'manual',
      offsite: false,
      consent: { version: 'manual', atMs: Date.now() },
    })
    onDone()
    setOpen(false)
  }

  if (!open)
    return (
      <button className="btn btn-sm" onClick={() => setOpen(true)}>
        + Добавить вручную
      </button>
    )
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="grid grid-2">
        <div className="field">
          <label>Услуга</label>
          <select value={form.serviceId} onChange={(e) => setForm({ ...form, serviceId: e.target.value })}>
            {bundle.services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Дата и время</label>
          <input type="datetime-local" value={form.when} onChange={(e) => setForm({ ...form, when: e.target.value })} />
        </div>
        {service?.needsSpecialist && (
          <div className="field">
            <label>Специалист</label>
            <select value={form.specialistId} onChange={(e) => setForm({ ...form, specialistId: e.target.value })}>
              {bundle.specialists.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
        {service?.needsHall && (
          <div className="field">
            <label>Зал</label>
            <select value={form.hallId} onChange={(e) => setForm({ ...form, hallId: e.target.value })}>
              {bundle.halls.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
        )}
        {service?.priceType === 'hourly' && (
          <div className="field">
            <label>Часов</label>
            <input type="number" min={1} max={14} value={form.hours} onChange={(e) => setForm({ ...form, hours: Number(e.target.value) })} />
          </div>
        )}
        <div className="field">
          <label>Имя клиента</label>
          <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label>Телефон</label>
          <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
      </div>
      <div className="chips">
        <button className="btn btn-sm btn-primary" onClick={save}>Сохранить</button>
        <button className="btn btn-sm" onClick={() => setOpen(false)}>Отмена</button>
      </div>
    </div>
  )
}

function Row({ b, bundle, slug, onChanged }: { b: BookingRecord; bundle: StudioBundle; slug: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [paid, setPaid] = useState(String(b.paidTotal))
  const [durl, setDurl] = useState(b.deliverablesUrl ?? '')
  const [when, setWhen] = useState(() => {
    const d = new Date(b.startsAtMs)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  })

  const specialist = bundle.specialists.find((s) => s.id === b.specialistId)
  const hall = bundle.halls.find((h) => h.id === b.hallId)

  async function setStatus(status: BookingRecord['status'], deliverablesUrl?: string) {
    await be.ownerUpdateBooking(slug, b.id, { status, ...(deliverablesUrl !== undefined ? { deliverablesUrl } : {}) })
    onChanged()
  }

  async function move() {
    if (!when) return
    const startMs = new Date(when).getTime()
    const duration = b.endsAtMs - b.startsAtMs
    await be.ownerUpdateBooking(slug, b.id, { startsAtMs: startMs, endsAtMs: startMs + duration })
    onChanged()
  }

  async function savePayment() {
    await be.ownerUpdateBooking(slug, b.id, { paidTotal: Number(paid) || 0 })
    onChanged()
  }

  async function saveUrl() {
    await be.ownerUpdateBooking(slug, b.id, { deliverablesUrl: durl })
    onChanged()
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="booking-row">
        <div>
          <strong>{b.serviceName}</strong>
          <div className="small muted">
            {humanDate(bundle.settings.tz, b.startsAtMs)}, {timeInTz(bundle.settings.tz, b.startsAtMs)}–{timeInTz(bundle.settings.tz, b.endsAtMs)}
            {specialist ? ` · ${specialist.name}` : ''}{hall ? ` · ${hall.name}` : ''}
          </div>
          <div className="small">
            {b.client.name} · <a href={`tel:${b.client.phone.replace(/[^+\d]/g, '')}`}>{b.client.phone}</a>
            {` · ${CONTACT_LABELS[b.client.method] ?? b.client.method}`}
            {b.client.method !== 'phone' && (
              <>
                {' '}
                <a href={contactHref(b.client.method, b.client.phone)} target="_blank" rel="noopener noreferrer">открыть чат</a>
              </>
            )}
            {b.client.people ? ` · ${b.client.people} чел.` : ''}
            {b.source === 'manual' ? ' · добавлено вручную' : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <StatusBadge status={b.status} />
          <div className="small muted">{money(b.price.total)}{b.paidTotal > 0 ? ` · оплачено ${money(b.paidTotal)}` : ''}</div>
        </div>
      </div>

      <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setOpen(!open)}>
        {open ? 'Скрыть' : 'Действия'}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div className="chips" style={{ marginBottom: 12 }}>
            <button className="chip" onClick={() => setStatus('confirmed')}>Подтвердить</button>
            <button className="chip" onClick={() => setStatus('prepaid')}>Предоплата получена</button>
            <button className="chip" onClick={() => setStatus('shot_done')}>Съёмка проведена</button>
            <button className="chip" onClick={() => setStatus('processing')}>В обработке</button>
            <button className="chip" onClick={() => setStatus('completed')}>Завершена</button>
            <button className="chip" onClick={() => setStatus('rejected')}>Отклонить</button>
            <button className="chip" onClick={() => setStatus('no_show')}>Не пришёл</button>
            <button className="chip" onClick={() => { if (confirm('Отметить как отменённую клиентом?')) setStatus('cancelled_by_client') }}>Отменена клиентом</button>
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label>Перенести на</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                <button className="btn btn-sm" onClick={move}>ОК</button>
              </div>
            </div>
            <div className="field">
              <label>Получено денег, ₽</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" value={paid} onChange={(e) => setPaid(e.target.value)} />
                <button className="btn btn-sm" onClick={savePayment}>ОК</button>
              </div>
            </div>
            <div className="field">
              <label>Ссылка на материалы</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="url" value={durl} onChange={(e) => setDurl(e.target.value)} placeholder="https://…" />
                <button className="btn btn-sm" onClick={saveUrl}>ОК</button>
              </div>
            </div>
            <div className="field">
              <label>Данные клиента</label>
              <button
                className="btn btn-sm"
                onClick={async () => {
                  if (confirm('Удалить персональные данные клиента из этой заявки?')) {
                    await be.ownerAnonymizeClient(slug, b.id)
                    onChanged()
                  }
                }}
              >
                Удалить по запросу
              </button>
            </div>
          </div>
          {b.client.notes && <p className="small">Пожелания: {b.client.notes}</p>}
          {!!b.client.referenceCount && <p className="small muted">Референсы: {b.client.referenceCount} шт. (приватно)</p>}
          <p className="small muted" style={{ marginBottom: 0 }}>
            Согласие: {b.consent.version} · {new Date(b.consent.atMs).toLocaleString('ru-RU')}
          </p>
        </div>
      )}
    </div>
  )
}

export default function Requests({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const [status, setStatus] = useState<BookingFilters['status']>('all')
  const [specialistId, setSpecialistId] = useState('')
  const [hallId, setHallId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const qc = useQueryClient()

  const filters = useMemo<BookingFilters>(
    () => ({ status, specialistId: specialistId || null, hallId: hallId || null, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined }),
    [status, specialistId, hallId, dateFrom, dateTo]
  )

  const { data, isLoading, error } = useQuery({
    queryKey: ['owner-bookings', slug, filters],
    queryFn: () => be.ownerBookings(slug, filters),
    refetchInterval: 30_000,
  })

  function exportCsv(rows: BookingRecord[]) {
    downloadCsv(
      `zayavki-${slug}.csv`,
      rows.map((b) => ({
        Дата: humanDate(bundle.settings.tz, b.startsAtMs),
        Время: timeInTz(bundle.settings.tz, b.startsAtMs),
        Услуга: b.serviceName,
        Статус: STATUS_LABELS[b.status],
        Клиент: b.client.name,
        Телефон: b.client.phone,
        Связь: b.client.method,
        Сумма: b.price.total,
        Оплачено: b.paidTotal,
        Источник: b.source,
      }))
    )
  }

  return (
    <Section>
      <ManualAdd bundle={bundle} slug={slug} onDone={() => qc.invalidateQueries({ queryKey: ['owner-bookings'] })} />

      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as BookingFilters['status'])}>
          <option value="all">Все статусы</option>
          <option value="active">Активные</option>
          {BOOKING_STATUSES.map((st) => <option key={st} value={st}>{STATUS_LABELS[st]}</option>)}
        </select>
        {bundle.specialists.length > 0 && (
          <select value={specialistId} onChange={(e) => setSpecialistId(e.target.value)}>
            <option value="">Все специалисты</option>
            {bundle.specialists.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {bundle.halls.length > 0 && (
          <select value={hallId} onChange={(e) => setHallId(e.target.value)}>
            <option value="">Все залы</option>
            {bundle.halls.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        )}
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="Дата с" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="Дата по" />
        <button className="chip" onClick={() => data && exportCsv(data)}>Экспорт CSV</button>
      </div>

      {isLoading && <Spinner />}
      {error && <ErrorBox>Не удалось загрузить заявки</ErrorBox>}
      {data && data.length === 0 && <Empty>Заявок по фильтру нет</Empty>}
      {data && data.map((b) => <Row key={b.id} b={b} bundle={bundle} slug={slug} onChanged={() => qc.invalidateQueries({ queryKey: ['owner-bookings'] })} />)}
    </Section>
  )
}
