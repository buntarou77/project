import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { buildFullDayWindows, calculatePrice } from '@/core/price'
import { buildSlotGrid, gridMinutesToMs } from '@/core/slotGrid'
import type { CreateBookingPayload } from '@/core/schema'
import type { Hall } from '@/core/types'
import { HallModal } from '@/ui/hallModal'
import { zonedToUtcMs } from '@/core/time'
import { CONSENT_VERSION } from '@/lib/env'
import { compressImage } from '@/lib/image'
import { money, humanDate, timeInTz, hoursLabel } from '@/ui/format'
import { ErrorBox, Section } from '@/ui/common'
import { downloadIcs } from '@/lib/ics'
import { saveBooking, getLastToken } from './bookingStorage'
import PushOptIn from './PushOptIn'

type Mode = 'shoot' | 'rental'

export default function BookPage({ bundle }: { bundle: StudioBundle }) {
  const { settings: s } = bundle
  const [params] = useSearchParams()
  const modes: Mode[] = [s.modes.shoots ? 'shoot' : null, s.modes.rental ? 'rental' : null].filter(Boolean) as Mode[]
  const [mode, setMode] = useState<Mode>(params.get('mode') === 'rental' ? 'rental' : modes[0])
  const services = bundle.services.filter((x) => x.kind === mode).sort((a, b) => a.sort - b.sort)
  const [serviceId, setServiceId] = useState(
    params.get('service') ?? services[0]?.id ?? ''
  )
  const service = services.find((x) => x.id === serviceId) ?? services[0]
  const activeSpecialists = bundle.specialists.filter((x) => x.active)
  // только специалисты, разрешённые услугой (белый список; пусто = все)
  const allowedSpecialists = activeSpecialists.filter(
    (sp) => !service?.specialistIds?.length || service.specialistIds.includes(sp.id)
  )
  const [specialistId, setSpecialistId] = useState<string | 'any'>('any')
  // залы, разрешённые для выбранной услуги (белый список + активные)
  const halls = bundle.halls.filter(
    (x) => x.active && (!service?.hallIds?.length || service.hallIds.includes(x.id))
  )
  const hallChoiceVisible = s.hallChoiceVisible !== false
  const [hallId, setHallId] = useState<string | null>(
    params.get('hall') ?? service?.defaultHallId ?? halls[0]?.id ?? null
  )
  // смена услуги может изменить набор разрешённых залов — выбранное сбрасываем
  useEffect(() => {
    setHallId((prev) => (prev && halls.some((h) => h.id === prev) ? prev : service?.defaultHallId ?? halls[0]?.id ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId])
  // ...и специалистов: запрещённого услугой B сбрасываем на «любого»,
  // иначе stale id уйдёт в заявку с вечной ошибкой «недоступен»
  useEffect(() => {
    setSpecialistId((prev) => (prev !== 'any' && !allowedSpecialists.some((sp) => sp.id === prev) ? 'any' : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId])
  // maxPeople новой услуги может быть меньше ранее выбранного — иначе сервер
  // молча для клиента отклонит заявку с people больше лимита
  useEffect(() => {
    setPeople((prev) => (service?.maxPeople && prev > service.maxPeople ? service.maxPeople : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId])
  const travelZones = s.travelZones
  const canOffsite = travelZones.length > 1 && service && !service.needsHall
  const [place, setPlace] = useState<'studio' | 'offsite'>('studio')
  const [zoneId, setZoneId] = useState(travelZones[0]?.id ?? null)
  const [date, setDate] = useState(params.get('date') ?? '')
  const [dayCount, setDayCount] = useState(1)
  const [durationH, setDurationH] = useState(() => {
    const h = Math.max(1, Math.round((service?.durationMin ?? 60) / 60))
    return Math.min(h, 8)
  })
  const [startMs, setStartMs] = useState<number | null>(null)
  const [people, setPeople] = useState(2)
  const [addonIds, setAddonIds] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [method, setMethod] = useState<'telegram' | 'whatsapp' | 'vk' | 'max' | 'phone'>(s.contactMethods[0]?.type ?? 'phone')
  const [consent, setConsent] = useState(false)
  const [refs, setRefs] = useState<File[]>([])
  const [submitState, setSubmitState] = useState<'idle' | 'sending' | 'done'>('idle')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [hallModal, setHallModal] = useState<Hall | null>(null)
  const [created, setCreated] = useState<{ token: string; startMs: number; endMs: number; price?: import('@/core/price').PriceBreakdown } | null>(null)
  const honeypot = useRef<HTMLInputElement>(null)
  const idemKey = useRef(crypto.randomUUID())

  useEffect(() => {
    setStartMs(null)
  }, [date, serviceId, specialistId, hallId, durationH, place, zoneId, dayCount, people])

  useEffect(() => {
    // чипы длительности — только 1–8 ч: при базе >8 ч ни один не был бы активен
    if (service) setDurationH(Math.min(8, Math.max(1, Math.round(service.durationMin / 60))))
  }, [serviceId, service])

  const zone = travelZones.find((z) => z.id === zoneId) ?? null
  const hall = halls.find((h) => h.id === hallId) ?? null
  const offsite = Boolean(canOffsite && place === 'offsite')
  // авто-режим выбора зала: сервер сам подбирает свободный разрешённый
  const pickHall = Boolean(service?.needsHall && hallChoiceVisible && hallId)
  // почасовая услуга занимает зал всегда — даже без галки «нужен зал»
  const hallUsed = Boolean(service && (service.needsHall || service.priceType === 'hourly'))
  // многодневная не-fullDay: сервер блокирует и тарифицирует все дни,
  // поэтому окна строим и для неё, а не только для «весь день»
  const multiDay = Boolean(service && service.multiDayMax > 1 && dayCount > 1)

  // допуслуги — только привязанные к выбранной услуге (легаси: по типу съёмки)
  const addonsForService = bundle.addons.filter(
    (a) =>
      service?.addonIds
        ? service.addonIds.includes(a.id)
        : a.appliesTo === mode || a.appliesTo === 'both'
  )

  // any-режим почасовой услуги со специалистом: сервер подберёт свободного
  // и прибавит его ставку — без неё оценка занижена. Берём минимальную
  // ставку разрешённых и показываем итог как «от …»; точную назовёт сервер.
  const anyEstimate = useMemo(() => {
    if (!service || service.priceType !== 'hourly' || !service.needsSpecialist || specialistId !== 'any') return null
    const rates = allowedSpecialists.map((sp) => sp.hourRate ?? 0).filter((r) => r > 0)
    return rates.length ? Math.min(...rates) : null
  }, [service, specialistId, allowedSpecialists])

  const estimate = useMemo(() => {
    if (!service) return null
    try {
      const windowsBased = service.fullDay || multiDay
      const fdStart = windowsBased && startMs ? startMs : null
      return calculatePrice({
        service,
        hall: hallUsed ? hall : null,
        tz: s.tz,
        // до выбора слота считаем по полдню выбранной даты (иначе тариф
        // выходного/вечера показался бы по «сейчас»)
        startUtcMs: startMs ?? (date ? zonedToUtcMs(s.tz, date, '12:00') : Date.now()),
        durationMin: service.fullDay ? undefined : durationH * 60,
        fullDayWindows:
          windowsBased && date
            ? buildFullDayWindows(s.schedule, s.tz, fdStart ?? zonedToUtcMs(s.tz, date, '12:00'), service.multiDayMax > 1 ? dayCount : 1).windows
            : undefined,
        // многодневная почасовая не-fullDay: окно каждого дня ограничено
        // выбранными часами, а не открыто→закрыто как у «весь день»
        hoursPerDay: !service.fullDay && service.priceType === 'hourly' ? durationH : undefined,
        peopleCount: people,
        selectedAddonIds: addonIds,
        addons: bundle.addons,
        travelZone: offsite ? zone : null,
        eveningFrom: s.eveningFrom,
        // ставка конкретного специалиста — только при явном выборе почасовой
        // услуги; «любой свободный» = минимальная ставка разрешённых (оценка «от»)
        specialist:
          service.priceType === 'hourly' && specialistId !== 'any'
            ? (() => {
                const sp = allowedSpecialists.find((x) => x.id === specialistId)
                return sp?.hourRate ? { name: sp.name, hourRate: sp.hourRate } : null
              })()
            : anyEstimate !== null
              ? { name: 'специалист', hourRate: anyEstimate }
              : null,
      })
    } catch {
      return null
    }
  }, [service, hall, s.tz, s.schedule, s.eveningFrom, startMs, date, durationH, hallUsed, specialistId, allowedSpecialists, mode, people, addonIds, bundle.addons, offsite, zone, dayCount, multiDay, anyEstimate])

  const dateFrom = date
  const slotsQuery = useQuery({
    queryKey: ['slots', s.slug, serviceId, dateFrom, specialistId, hallId, durationH, place, zoneId, dayCount, people, mode],
    queryFn: () =>
      be.getAvailability({
        slug: s.slug,
        serviceId,
        dateFrom,
        dayCount: service?.multiDayMax > 1 ? dayCount : 1,
        durationMin: durationH * 60,
        specialistId: service?.needsSpecialist ? (specialistId === 'any' ? null : specialistId) : null,
        hallId: hallUsed && pickHall ? hallId : null,
        offsite,
        travelZoneId: offsite ? zoneId : null,
        peopleCount: people,
      }),
    enabled: Boolean(dateFrom && service),
  })

  async function onRefsChange(files: FileList | null) {
    if (!files) return
    const picked = Array.from(files).slice(0, 5)
    for (const f of picked) {
      if (!f.type.startsWith('image/')) continue
      try {
        await compressImage(f)
      } catch {
        setSubmitError('Не удалось обработать одно из изображений')
      }
    }
    setRefs(picked)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    if (!service || !startMs) return
    if (!navigator.onLine) {
      setSubmitError('Нет сети. Отправить заявку нельзя — проверьте интернет и попробуйте снова.')
      return
    }
    setSubmitState('sending')
    // «весь день»: длительность и конец считает сервер по графику студии
    const durationMin = service.fullDay ? undefined : durationH * 60
    const payload: CreateBookingPayload = {
      slug: s.slug,
      kind: mode,
      serviceId: service.id,
      specialistId: service.needsSpecialist ? (specialistId === 'any' ? null : specialistId) : null,
      hallId: hallUsed && pickHall ? hallId : null,
      startUtcMs: startMs,
      durationMin,
      dayCount: service.multiDayMax > 1 ? dayCount : 1,
      peopleCount: people,
      offsite,
      travelZoneId: offsite ? zoneId : null,
      addonIds,
      client: { name, phone, method, notes: notes || undefined, referenceCount: refs.length || undefined },
      consent,
      honeypot: honeypot.current?.value ?? '',
      idempotencyKey: idemKey.current,
    }
    try {
      const res = await be.createBooking(payload)
      if (res.ok) {
        // При дубликате сервер не возвращает токен (секрет хранится хешем) —
        // сохраняем тот, что был выдан первым ответом.
        if (res.token) {
          saveBooking(s.slug, { token: res.token, serviceName: service.name, startsAtMs: startMs, createdAtMs: Date.now() })
        }
        const effectiveToken = res.token || getLastToken(s.slug) || created?.token || ''
        // «весь день» и многодневная: конец — закрытие последнего дня по графику;
        // фикс-пакет кратный — занято всё оплаченное (k×баз), почасовая — выбранные часы
        const k = Math.max(1, Math.ceil((durationH * 60) / service.durationMin))
        const endMs =
          service.fullDay || multiDay
            ? buildFullDayWindows(s.schedule, s.tz, startMs, service.multiDayMax > 1 ? dayCount : 1).lastCloseMs
            : service.priceType === 'fixed'
              ? startMs + k * service.durationMin * 60_000
              : startMs + durationH * 60 * 60_000
        // серверная цена точнее оценки (например, при автоподборе зала)
        setCreated({ token: effectiveToken, startMs, endMs, price: res.price })
        setSubmitState('done')
      } else {
        setSubmitError(res.error)
        setSubmitState('idle')
      }
    } catch {
      // адаптер может бросить исключение, а не вернуть {ok:false} —
      // без этого форма осталась бы вечно в «Отправляем…»
      setSubmitError('Не удалось отправить заявку. Попробуйте ещё раз.')
      setSubmitState('idle')
    }
  }

  if (submitState === 'done' && created) {
    const svc = service!
    const finalPrice = created.price ?? estimate
    return (
      <Section>
        <div style={{ maxWidth: 640, marginInline: 'auto' }}>
        <div className="overline">Готово</div>
        <h2>Заявка отправлена</h2>
        <p>
          {svc.autoConfirm
            ? 'Время забронировано автоматически.'
            : 'Владелец подтвердит запись — статус виден в разделе «Моя запись».'}
        </p>
        <div className="card" style={{ maxWidth: 520, marginInline: 'auto' }}>
          <div className="sum-row"><span>Услуга</span><b>{svc.name}</b></div>
          <div className="sum-row"><span>Когда</span><b>{humanDate(s.tz, created.startMs)}, {timeInTz(s.tz, created.startMs)}</b></div>
          {finalPrice && <div className="sum-row"><span>Стоимость</span><b>{money(finalPrice.total)}</b></div>}
          {finalPrice && finalPrice.prepayment > 0 && (
            <div className="sum-row"><span>Предоплата</span><b>{money(finalPrice.prepayment)}</b></div>
          )}
          <p className="small muted">
            Сохраните секретную ссылку — по ней доступна запись без регистрации:
          </p>
          <code className="small" style={{ wordBreak: 'break-all' }}>
            {location.origin}/s/{s.slug}/my/{created.token}
          </code>
          <div className="chips" style={{ marginTop: 14 }}>
            <button
              className="chip"
              onClick={() =>
                downloadIcs('zapis.ics', {
                  title: `${svc.name} — ${s.name}`,
                  startMs: created.startMs,
                  endMs: created.endMs,
                  location: s.address,
                })
              }
            >
              Добавить в календарь (.ics)
            </button>
            <Link className="chip" to={`/s/${s.slug}/my/${created.token}`}>Моя запись</Link>
          </div>
          <PushOptIn slug={s.slug} />
          <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
            Напоминание за сутки: пришлём push, если они включены на устройстве; иначе добавьте событие в календарь.
          </p>
        </div>
        </div>
      </Section>
    )
  }

  return (
    <Section>
      <div style={{ maxWidth: 640, marginInline: 'auto' }}>
      <div className="overline">{s.name}</div>
      <h2>{mode === 'rental' ? 'Аренда студии' : 'Запись на съёмку'}</h2>

      {modes.length > 1 && (
        <div className="chips" style={{ marginBottom: 20 }}>
          <button className={`chip ${mode === 'shoot' ? 'active' : ''}`} onClick={() => { setMode('shoot'); setServiceId(bundle.services.find((x) => x.kind === 'shoot')!.id) }}>
            Съёмка
          </button>
          <button className={`chip ${mode === 'rental' ? 'active' : ''}`} onClick={() => { setMode('rental'); setServiceId(bundle.services.find((x) => x.kind === 'rental')!.id) }}>
            Аренда студии
          </button>
        </div>
      )}

      <form onSubmit={submit} style={{ maxWidth: 640, position: 'relative' }}>
        <div className="field hp-field" aria-hidden="true">
          <label>Не заполняйте это поле<input ref={honeypot} type="text" tabIndex={-1} autoComplete="off" /></label>
        </div>

        <div className="field">
          <label>Услуга</label>
          <div className="service-cards">
            {services.map((svc) => (
              <button
                type="button"
                key={svc.id}
                className={`sp-card svc ${serviceId === svc.id ? 'active' : ''}`}
                onClick={() => setServiceId(svc.id)}
              >
                {svc.photoUrl ? (
                  <img src={svc.photoUrl} alt={svc.name} className="svc-img" loading="lazy" />
                ) : (
                  <span className="svc-img svc-img-ph">
                    <span className="avatar-fallback">
                      {svc.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
                    </span>
                  </span>
                )}
                <span className="sp-card-info">
                  <b>{svc.name}</b>
                  <span className="small muted">
                    {svc.priceType === 'fixed'
                      ? money(svc.price)
                      : halls.length > 0
                        ? `от ${money(Math.min(...halls.map((h) => h.rates.weekday.day)))}/час`
                        : 'по тарифу зала'}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {service && (
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              {service.deliverableText && <>Состав: {service.includes.join(', ')}. </>}
              {service.deadlineDays > 0 && <>Сдача за {service.deadlineDays} дн. </>}
              Предоплата: {service.prepayment.type === 'percent' ? `${service.prepayment.value}%` : money(service.prepayment.value)}.
              {hallUsed && halls.length > 0 && ' + зал по тарифу зала (строка в «Итого»).'}
            </p>
          )}
        </div>

        {service?.needsSpecialist && allowedSpecialists.length > 1 && s.specialistChoiceVisible !== false && (
          <div className="field">
            <label>Специалист</label>
            <div className="specialist-cards">
              <button
                type="button"
                className={`sp-card ${specialistId === 'any' ? 'active' : ''}`}
                onClick={() => setSpecialistId('any')}
              >
                <span className="sp-photo small">
                  <span className="avatar-fallback">✦</span>
                </span>
                <span className="sp-card-info">
                  <b>Любой свободный</b>
                  <span className="small muted">подберём автоматически</span>
                </span>
              </button>
              {allowedSpecialists.map((sp) => (
                <button
                  type="button"
                  key={sp.id}
                  className={`sp-card ${specialistId === sp.id ? 'active' : ''}`}
                  onClick={() => setSpecialistId(sp.id)}
                >
                  <span className="sp-photo small">
                    {sp.photoUrl ? (
                      <img src={sp.photoUrl} alt={sp.name} loading="lazy" />
                    ) : (
                      <span className="avatar-fallback">
                        {sp.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span className="sp-card-info">
                    <b>{sp.name}</b>
                    <span className="small muted">
                      {sp.title}
                      {sp.hourRate && service.priceType === 'hourly' ? ` · +${money(sp.hourRate)}/час` : ''}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        {service?.needsSpecialist && allowedSpecialists.length > 1 && s.specialistChoiceVisible === false && (
          <p className="small muted" style={{ margin: '0 0 8px' }}>Специалист подберётся автоматически — свободный на выбранное время.</p>
        )}
        {service?.needsSpecialist && allowedSpecialists.length === 1 && (
          <p className="small muted" style={{ margin: '0 0 8px' }}>
            Съёмку проведёт: {allowedSpecialists[0].name}
            {allowedSpecialists[0].title ? ` — ${allowedSpecialists[0].title}` : ''}.
          </p>
        )}

        {hallUsed && halls.length > 1 && hallChoiceVisible && (
          <div className="field">
            <label>Зал</label>
            <div className="hall-cards">
              {halls.map((h) => (
                <div
                  key={h.id}
                  role="button"
                  tabIndex={0}
                  className={`sp-card svc hall-card ${hallId === h.id ? 'active' : ''}`}
                  onClick={() => setHallId(h.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setHallId(h.id)}
                >
                  {h.photos?.[0] ? (
                    <img src={h.photos[0]} alt={h.name} className="svc-img" loading="lazy" />
                  ) : (
                    <span className="svc-img svc-img-ph">
                      <span className="avatar-fallback">
                        {h.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
                      </span>
                    </span>
                  )}
                  <span className="sp-card-info">
                    <b>{h.name}</b>
                    <span className="small muted">до {h.capacity} чел. · от {money(Math.min(h.rates.weekday.day, h.rates.weekend.day))}/час</span>
                  </span>
                  <button
                    type="button"
                    className="hall-photo-link"
                    title="Информация и все фото зала"
                    onClick={(e) => {
                      e.stopPropagation()
                      setHallModal(h)
                    }}
                  >
                    ℹ фото и цены
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {hallUsed && halls.length > 1 && !hallChoiceVisible && (
          <p className="small muted" style={{ margin: '0 0 8px' }}>Зал подберётся автоматически — свободный из подходящих для услуги.</p>
        )}
        {hallUsed && hall && (
          <div className="hall-preview">
            {(hall.photos ?? []).slice(0, 3).map((src) => (
              <img key={src} src={src} alt={hall.name} loading="lazy" />
            ))}
            <span className="small muted">
              {(hall.photos?.length ?? 0) > 0
                ? `${hall.name}${hallChoiceVisible || halls.length > 1 ? ' · выбранный зал' : ' · пример зала'}`
                : hall.name}
            </span>
          </div>
        )}

        {canOffsite && (
          <div className="field">
            <label>Где проходит съёмка</label>
            <select value={place} onChange={(e) => setPlace(e.target.value as 'studio' | 'offsite')}>
              <option value="studio">В студии / по городу</option>
              <option value="offsite">Выезд</option>
            </select>
            {place === 'offsite' && (
              <select value={zoneId ?? ''} onChange={(e) => setZoneId(e.target.value)} style={{ marginTop: 8 }}>
                {travelZones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}{z.extraFee ? ` (+${money(z.extraFee)})` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <div className="field">
          <label>Дата</label>
          <input type="date" required value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />
        </div>

        {service && service.multiDayMax > 1 && (
          <div className="field">
            <label>Сколько дней</label>
            <select value={dayCount} onChange={(e) => setDayCount(Number(e.target.value))}>
              {Array.from({ length: service.multiDayMax }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        )}

        {service && !service.fullDay && (
          <div className="field">
            <label>{multiDay ? 'Длительность (в день)' : 'Длительность'}</label>
            <div className="chips">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((h) => (
                <button type="button" key={h} className={`chip ${durationH === h ? 'active' : ''}`} onClick={() => setDurationH(h)}>
                  {hoursLabel(h)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label>Время {date ? '' : '(сначала выберите дату)'}</label>
          {date && service && !service.fullDay && (
            <p className="small muted" style={{ margin: '0 0 8px' }}>
              Длительность брони: {hoursLabel(durationH)}. Каждая кнопка — время начала, занято будет всё время брони.
            </p>
          )}
          {!date && <p className="small muted">Сначала выберите дату. Занятое время будет перечёркнуто.</p>}
          {date && slotsQuery.isLoading && (
            <p className="small muted"><span className="spinner-inline" aria-hidden="true" /> Смотрим свободное время…</p>
          )}
          {date && slotsQuery.isError && (
            <ErrorBox>Не удалось загрузить свободное время. Проверьте интернет и выберите дату ещё раз.</ErrorBox>
          )}
          {date && slotsQuery.isSuccess && !service?.fullDay && (() => {
            const slots = slotsQuery.data?.slots ?? []
            const free = new Set(slots.map((x) => x.startMs))
            const grid = buildSlotGrid(s.schedule, date, 30).map((m) => gridMinutesToMs(s.tz, date, m))
            return (
              <>
                {grid.length === 0 && (
                  <p className="small muted">В этот день студия закрыта (выходной или праздник) — выберите другую дату.</p>
                )}
                {grid.length > 0 && free.size === 0 && (
                  <p className="small muted">
                    {slotsQuery.data?.reason ?? 'На эту дату свободных слотов нет: время занято или уже прошло. Выберите другую дату.'}
                  </p>
                )}
                {grid.length > 0 && (
                  <div className="slots">
                    {grid.map((ms) => (
                      <button
                        type="button"
                        key={ms}
                        className={`slot ${startMs === ms ? 'active' : ''}`}
                        disabled={!free.has(ms)}
                        onClick={() => setStartMs(ms)}
                      >
                        {timeInTz(s.tz, ms)}
                      </button>
                    ))}
                  </div>
                )}
                {grid.length > 0 && free.size > 0 && free.size < grid.length && (
                  <p className="small muted" style={{ marginTop: 8 }}>Перечёркнутое время уже занято.</p>
                )}
              </>
            )
          })()}
          {date && slotsQuery.isSuccess && service?.fullDay && (
            slotsQuery.data?.slots.length ? (() => {
              const fdStart = slotsQuery.data.slots[0].startMs
              // часы/подпись считаем по всем выбранным дням, не только первому
              const fdw = buildFullDayWindows(s.schedule, s.tz, fdStart, service.multiDayMax > 1 ? dayCount : 1)
              const fdHours = Math.round(fdw.totalMinutes / 60)
              const fdActive = startMs === fdStart
              return (
                <button
                  type="button"
                  className={`full-day-card ${fdActive ? 'active' : ''}`}
                  onClick={() => setStartMs(fdStart)}
                >
                  <span className="full-day-head">
                    <b>Весь день</b>
                    {estimate && fdActive && <b>{money(estimate.total)}</b>}
                  </span>
                  <span className="small muted">
                    {fdw.windows[0]?.open}–{fdw.windows[fdw.windows.length - 1]?.close} · {hoursLabel(fdHours)} зала
                    {estimate && !fdActive ? ` · ${money(estimate.total)}` : ''}
                  </span>
                </button>
              )
            })() : (
              <p className="small muted">Весь день на эту дату занят — выберите другую дату.</p>
            )
          )}
        </div>

        <div className="field">
          <label>Количество человек{service?.maxPeople ? ` (максимум ${service.maxPeople})` : ''}</label>
          <input type="number" min={1} max={service?.maxPeople ?? 50} value={people} onChange={(e) => setPeople(Math.max(1, Math.min(Number(e.target.value), service?.maxPeople ?? 50)))} />
        </div>

        {addonsForService.length > 0 && (
          <div className="field">
            <label>Дополнительно</label>
            {addonsForService.map((a) => (
              <label className="checkline" key={a.id} style={{ marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={addonIds.includes(a.id)}
                  onChange={(e) => setAddonIds(e.target.checked ? [...addonIds, a.id] : addonIds.filter((x) => x !== a.id))}
                />
                <span>{a.name} <span className="muted">+{money(a.price)}{a.unit === 'hour' ? '/час' : a.unit === 'person' ? '/чел.' : ''}</span></span>
              </label>
            ))}
          </div>
        )}

        <div className="field">
          <label>Референсы (до 5 изображений)</label>
          <input type="file" accept="image/*" multiple onChange={(e) => onRefsChange(e.target.files)} />
          {refs.length > 0 && <p className="small muted">Выбрано: {refs.length}. Изображения видит только владелец.</p>}
        </div>

        <div className="field">
          <label>Пожелания</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Идея, место, сроки…" />
        </div>

        <div className="field">
          <label>Имя</label>
          <input type="text" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </div>
        <div className="field">
          <label>Телефон</label>
          <input type="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 …" autoComplete="tel" />
        </div>
        <div className="field">
          <label>Способ связи</label>
          <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="phone">Звонок</option>
            {s.contactMethods.map((m) => (
              <option key={m.type} value={m.type}>{m.type}</option>
            ))}
            <option value="telegram">Telegram</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="max">MAX</option>
          </select>
        </div>

        {estimate && (
          <div className="summary" style={{ marginBottom: 16 }}>
            {estimate.lines.map((l, i) => (
              <div className="sum-row" key={i}><span>{l.label}</span><span>{money(l.amount)}</span></div>
            ))}
            <div className="sum-row total">
              <span>Итого</span>
              <span>{anyEstimate !== null ? `от ${money(estimate.total)}` : money(estimate.total)}</span>
            </div>
            {anyEstimate !== null && (
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                точная ставка специалиста зависит от того, кто свободен
              </p>
            )}
            {estimate.prepayment > 0 && (
              <div className="sum-row small muted"><span>Предоплата после подтверждения</span><span>{money(estimate.prepayment)}</span></div>
            )}
            <p className="small muted" style={{ margin: '6px 0 0' }}>Предварительная стоимость.</p>
          </div>
        )}

        <label className="checkline field">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            Согласен на обработку персональных данных (<Link to="policy">политика</Link>)
          </span>
        </label>

        {submitError && <ErrorBox>{submitError}</ErrorBox>}

        <button className="btn btn-primary btn-block" disabled={!consent || !startMs || submitState === 'sending'}>
          {submitState === 'sending' ? 'Отправляем…' : 'Отправить заявку'}
        </button>
        {!startMs && (
          <p className="small muted" style={{ margin: '8px 0 0', textAlign: 'center' }}>
            {date
              ? 'Выберите свободное время в блоке «Время» выше — без него заявку отправить нельзя.'
              : 'Выберите дату и свободное время — без них заявку отправить нельзя.'}
          </p>
        )}
        {startMs && !consent && (
          <p className="small muted" style={{ margin: '8px 0 0', textAlign: 'center' }}>
            Поставьте галочку согласия на обработку персональных данных — она выше.
          </p>
        )}
      </form>
      </div>
      {hallModal && <HallModal hall={hallModal} slug={s.slug} onClose={() => setHallModal(null)} />}
    </Section>
  )
}
