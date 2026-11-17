import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { backend as be, type BookingFilters, type BookingRecord, type StudioBundle, STATUS_LABELS, BOOKING_STATUSES, STATUS_ACTIVE } from '@/backend'
import { Empty, ErrorBox, Section, Spinner, StatusBadge, ConfirmDialog, AsyncButton } from '@/ui/common'
import { humanDate, money, timeInTz } from '@/ui/format'
import { contactHref, CONTACT_LABELS } from '@/lib/links'
import { downloadCsv } from '@/lib/csv'
import { zonedToUtcMs, utcToZonedDate } from '@/core/time'
import { buildFullDayWindows, calculatePrice, type PriceBreakdown } from '@/core/price'
import { toast, toastError } from '@/ui/toast'

// Матрица статусных переходов — единая с сервером, чтобы владелец не тыкал
// в чипы, которые вернут 400. CHAIN — цепочка исполнения по порядку;
// CLOSED — закрывающие статусы; completed — терминальный.
const STATUS_CHAIN: BookingRecord['status'][] = ['new', 'confirmed', 'prepaid', 'shot_done', 'processing', 'delivered', 'completed']
const STATUS_CLOSED: BookingRecord['status'][] = ['cancelled_by_client', 'rejected', 'no_show']

function nextStatuses(current: BookingRecord['status']): BookingRecord['status'][] {
  if (current === 'completed') return []
  if (STATUS_CLOSED.includes(current)) {
    // ре-открытие: в любой активный; CLOSED→CLOSED — тоже можно
    return [...STATUS_ACTIVE, ...STATUS_CLOSED.filter((s) => s !== current)]
  }
  const i = STATUS_CHAIN.indexOf(current)
  if (i === -1) return []
  return [
    ...STATUS_CHAIN.slice(i + 1), // вперёд — на любой следующий
    ...(i > 0 ? [STATUS_CHAIN[i - 1]] : []), // назад — ровно на один шаг
    ...STATUS_CLOSED, // из активного в закрывающий
  ]
}

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
  // почасовая услуга занимает зал всегда, даже без галки «нужен зал»
  const needHall = Boolean(service && (service.needsHall || service.priceType === 'hourly'))
  // селекты — только по белым спискам услуги (пусто = все активные)
  const allowedHalls = bundle.halls.filter((h) => h.active && (!service?.hallIds?.length || service.hallIds.includes(h.id)))
  const allowedSpecialists = bundle.specialists.filter(
    (sp) => sp.active && (!service?.specialistIds?.length || service.specialistIds.includes(sp.id))
  )
  // дефолт — первый разрешённый (в форме мог остаться id, запрещённый услугой)
  const hallValue = allowedHalls.some((h) => h.id === form.hallId) ? form.hallId : allowedHalls[0]?.id ?? ''
  const specialistValue = allowedSpecialists.some((sp) => sp.id === form.specialistId)
    ? form.specialistId
    : allowedSpecialists[0]?.id ?? ''

  async function save() {
    if (!service || !form.when) return
    const hall = allowedHalls.find((h) => h.id === hallValue) ?? null
    if (needHall && !hall) {
      toastError(new Error('Для этой услуги нужен зал — выберите зал или добавьте подходящий в настройках'))
      return
    }
    const specialist = service.needsSpecialist ? allowedSpecialists.find((sp) => sp.id === specialistValue) ?? null : null
    const startMs = zonedToUtcMs(bundle.settings.tz, form.when.slice(0, 10), form.when.slice(11, 16))
    // «весь день»: длительность и конец — по окнам графика студии
    const fdw = service.fullDay ? buildFullDayWindows(bundle.settings.schedule, bundle.settings.tz, startMs, 1) : null
    const durationMin = fdw ? fdw.totalMinutes : service.priceType === 'hourly' ? form.hours * 60 : service.durationMin
    const endsAtMs = fdw ? fdw.lastCloseMs : startMs + durationMin * 60_000
    // цену считает только ядро (для hourly поле price услуги игнорируется)
    let price: PriceBreakdown
    try {
      price = calculatePrice({
        service,
        hall,
        tz: bundle.settings.tz,
        startUtcMs: startMs,
        durationMin,
        fullDayWindows: fdw?.windows,
        // ставка специалиста прибавляется только у почасовых услуг
        specialist:
          service.priceType === 'hourly' && specialist?.hourRate
            ? { name: specialist.name, hourRate: specialist.hourRate }
            : null,
        peopleCount: 1,
        selectedAddonIds: [],
        addons: bundle.addons,
        travelZone: null,
        eveningFrom: bundle.settings.eveningFrom,
      })
    } catch (e) {
      toastError(e)
      return
    }
    await be.ownerCreateBookingManual(slug, {
      slug,
      kind: service.kind,
      serviceId: service.id,
      serviceName: service.name,
      specialistId: service.needsSpecialist ? specialistValue || null : null,
      hallId: needHall ? hallValue || null : null,
      startsAtMs: startMs,
      endsAtMs,
      allDay: service.fullDay,
      dayCount: 1,
      status: 'confirmed',
      client: { name: form.name || 'Клиент', phone: form.phone || '—', method: 'phone' },
      price,
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
            <select value={specialistValue} onChange={(e) => setForm({ ...form, specialistId: e.target.value })}>
              {allowedSpecialists.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
        {needHall && (
          <div className="field">
            <label>Зал</label>
            <select value={hallValue} onChange={(e) => setForm({ ...form, hallId: e.target.value })}>
              {allowedHalls.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
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

function Row({ b, bundle, slug, onChanged, hideMoney }: { b: BookingRecord; bundle: StudioBundle; slug: string; onChanged: () => void; hideMoney: boolean }) {
  const [open, setOpen] = useState(false)
  const [paid, setPaid] = useState(String(b.paidTotal))
  const [durl, setDurl] = useState(b.deliverablesUrl ?? '')
  const tz = bundle.settings.tz
  // datetime-local в таймзоне СТУДИИ (кабинет показывает всё в tz студии)
  const toLocalInput = (ms: number) => `${utcToZonedDate(tz, ms)}T${timeInTz(tz, ms)}`
  const [when, setWhen] = useState(() => toLocalInput(b.startsAtMs))
  const [ask, setAsk] = useState<null | 'cancel' | 'anonymize' | 'prepaid'>(null)
  // допустимые переходы ограничивают набор чипов-действий
  const next = nextStatuses(b.status)

  // рефетч каждые 30 с приносит свежие данные — не даём инпутам протухнуть
  // (риск перезаписать чужие правки вторым менеджером)
  useEffect(() => {
    setPaid(String(b.paidTotal))
    setDurl(b.deliverablesUrl ?? '')
    setWhen(toLocalInput(b.startsAtMs))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.id, b.paidTotal, b.deliverablesUrl, b.startsAtMs])

  const specialist = bundle.specialists.find((s) => s.id === b.specialistId)
  const hall = bundle.halls.find((h) => h.id === b.hallId)

  async function setStatus(status: BookingRecord['status'], deliverablesUrl?: string) {
    await be.ownerUpdateBooking(slug, b.id, { status, ...(deliverablesUrl !== undefined ? { deliverablesUrl } : {}) })
    onChanged()
    toast('Статус обновлён')
  }

  // недовнос: прежде чем отмечать предоплату полученной — переспросить
  function requestPrepaid() {
    if (b.price.prepayment > 0 && b.paidTotal < b.price.prepayment) {
      setAsk('prepaid')
      return Promise.resolve()
    }
    return setStatus('prepaid')
  }

  async function move() {
    if (!when) return
    const [date, time] = when.split('T')
    const startMs = zonedToUtcMs(tz, date, time)
    const duration = b.endsAtMs - b.startsAtMs
    await be.ownerUpdateBooking(slug, b.id, { startsAtMs: startMs, endsAtMs: startMs + duration })
    onChanged()
    toast('Заявка перенесена')
  }

  async function savePayment() {
    await be.ownerUpdateBooking(slug, b.id, { paidTotal: Number(paid) || 0 })
    onChanged()
    toast('Оплата сохранена')
  }

  async function saveUrl() {
    await be.ownerUpdateBooking(slug, b.id, { deliverablesUrl: durl })
    onChanged()
    toast('Ссылка сохранена')
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
          {/* сотрудник сумм не видит (сервер маскирует только paidTotal) */}
          {!hideMoney && (
            <div className="small muted">{money(b.price.total)}{b.paidTotal > 0 ? ` · оплачено ${money(b.paidTotal)}` : ''}</div>
          )}
        </div>
      </div>

      <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setOpen(!open)}>
        {open ? 'Скрыть' : 'Действия'}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {next.length > 0 && (
            <div className="chips" style={{ marginBottom: 12 }}>
              {next.includes('confirmed') && <AsyncButton className="chip" busyLabel="Меняем…" onClick={() => setStatus('confirmed')}>Подтвердить</AsyncButton>}
              {next.includes('prepaid') && <AsyncButton className="chip" busyLabel="Меняем…" onClick={requestPrepaid}>Предоплата получена</AsyncButton>}
              {next.includes('shot_done') && <AsyncButton className="chip" busyLabel="Меняем…" onClick={() => setStatus('shot_done')}>Съёмка проведена</AsyncButton>}
              {next.includes('processing') && <AsyncButton className="chip" busyLabel="Меняем…" onClick={() => setStatus('processing')}>В обработке</AsyncButton>}
              {next.includes('completed') && <AsyncButton className="chip" busyLabel="Меняем…" onClick={() => setStatus('completed')}>Завершена</AsyncButton>}
              {next.includes('rejected') && <AsyncButton className="chip" busyLabel="Меняем…" onClick={() => setStatus('rejected')}>Отклонить</AsyncButton>}
              {next.includes('no_show') && <AsyncButton className="chip" busyLabel="Меняем…" onClick={() => setStatus('no_show')}>Не пришёл</AsyncButton>}
              {next.includes('cancelled_by_client') && <AsyncButton className="chip" busyLabel="Меняем…" onClick={async () => setAsk('cancel')}>Отменена клиентом</AsyncButton>}
            </div>
          )}
          <div className="grid grid-2">
            <div className="field">
              <label>Перенести на</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                <AsyncButton className="btn btn-sm" busyLabel="Переносим…" onClick={move}>ОК</AsyncButton>
              </div>
            </div>
            {!hideMoney && (
              <div className="field">
                <label>Получено денег, ₽</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="number" value={paid} onChange={(e) => setPaid(e.target.value)} />
                  <AsyncButton className="btn btn-sm" onClick={savePayment}>ОК</AsyncButton>
                </div>
              </div>
            )}
            <div className="field">
              <label>Ссылка на материалы</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="url" value={durl} onChange={(e) => setDurl(e.target.value)} placeholder="https://…" />
                <AsyncButton className="btn btn-sm" onClick={saveUrl}>ОК</AsyncButton>
              </div>
            </div>
            <div className="field">
              <label>Данные клиента</label>
              <button className="btn btn-sm" onClick={() => setAsk('anonymize')}>
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

      <ConfirmDialog
        open={ask !== null}
        title={ask === 'anonymize' ? 'Удалить данные клиента?' : ask === 'prepaid' ? 'Предоплата внесена не полностью' : 'Отменить заявку?'}
        text={
          ask === 'anonymize'
            ? 'Имя, телефон и пожелания будут обезличены. Действие необратимо.'
            : ask === 'prepaid'
              ? `Внесено ${money(b.paidTotal)} из ${money(b.price.prepayment)}. Отметить предоплату полученной?`
              : 'Статус изменится на «Отменена клиентом», время освободится для других клиентов.'
        }
        confirmLabel={ask === 'anonymize' ? 'Удалить данные' : ask === 'prepaid' ? 'Да, отметить' : 'Да, отменить'}
        danger={ask === 'anonymize'}
        onConfirm={async () => {
          try {
            if (ask === 'anonymize') {
              await be.ownerAnonymizeClient(slug, b.id)
              onChanged()
              toast('Данные клиента удалены')
            } else if (ask === 'prepaid') {
              await setStatus('prepaid')
            } else if (ask === 'cancel') {
              await setStatus('cancelled_by_client')
            }
          } catch (e) {
            toastError(e)
          }
          setAsk(null)
        }}
        onCancel={() => setAsk(null)}
      />
    </div>
  )
}

export default function Requests({ bundle, slug, role = 'owner' }: { bundle: StudioBundle; slug: string; role?: string }) {
  // сотрудник не должен видеть суммы: сервер маскирует только paidTotal
  const hideMoney = role === 'employee'
  const [status, setStatus] = useState<BookingFilters['status']>('all')
  const [specialistId, setSpecialistId] = useState('')
  const [hallId, setHallId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [search, setSearch] = useState('')
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

  // поиск по клиенту/телефону — локально, поверх серверных фильтров
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return data ?? []
    return (data ?? []).filter(
      (b) =>
        b.client.name.toLowerCase().includes(q) ||
        b.client.phone.toLowerCase().includes(q) ||
        b.serviceName.toLowerCase().includes(q)
    )
  }, [data, search])

  function exportCsv(list: BookingRecord[]) {
    downloadCsv(
      `zayavki-${slug}-${new Date().toISOString().slice(0, 10)}.csv`,
      list.map((b) => ({
        Дата: humanDate(bundle.settings.tz, b.startsAtMs),
        Время: timeInTz(bundle.settings.tz, b.startsAtMs),
        Услуга: b.serviceName,
        Специалист: bundle.specialists.find((s) => s.id === b.specialistId)?.name ?? '',
        Зал: bundle.halls.find((h) => h.id === b.hallId)?.name ?? '',
        Статус: STATUS_LABELS[b.status],
        Клиент: b.client.name,
        Телефон: b.client.phone,
        Связь: CONTACT_LABELS[b.client.method] ?? b.client.method,
        ...(hideMoney ? {} : { Сумма: b.price.total, Оплачено: b.paidTotal }),
        Источник: b.source,
      }))
    )
  }

  return (
    <Section>
      {!hideMoney && (
        <ManualAdd bundle={bundle} slug={slug} onDone={() => qc.invalidateQueries({ queryKey: ['owner-bookings'] })} />
      )}

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
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск: имя, телефон, услуга…"
          aria-label="Поиск по клиенту"
          style={{ minWidth: 200 }}
        />
        <button className="chip" onClick={() => rows.length > 0 && exportCsv(rows)}>Экспорт CSV</button>
      </div>

      {isLoading && <Spinner />}
      {error && <ErrorBox>Не удалось загрузить заявки</ErrorBox>}
      {data && data.length === 0 && <Empty>Заявок по фильтру нет</Empty>}
      {data && data.length > 0 && rows.length === 0 && <Empty>По запросу «{search}» ничего не найдено</Empty>}
      {rows.map((b) => <Row key={b.id} b={b} bundle={bundle} slug={slug} hideMoney={hideMoney} onChanged={() => qc.invalidateQueries({ queryKey: ['owner-bookings'] })} />)}
    </Section>
  )
}
