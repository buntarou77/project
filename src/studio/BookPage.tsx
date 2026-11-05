import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { calculatePrice } from '@/core/price'
import { buildSlotGrid, gridMinutesToMs } from '@/core/slotGrid'
import type { CreateBookingPayload } from '@/core/schema'
import { CONSENT_VERSION } from '@/lib/env'
import { compressImage } from '@/lib/image'
import { money, humanDate, timeInTz, hoursLabel } from '@/ui/format'
import { ErrorBox, Section } from '@/ui/common'
import { downloadIcs } from '@/lib/ics'
import { saveLastToken } from './bookingStorage'

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
  const [specialistId, setSpecialistId] = useState<string | 'any'>('any')
  const halls = bundle.halls.filter((x) => x.active)
  const [hallId, setHallId] = useState<string | null>(
    params.get('hall') ?? service?.defaultHallId ?? halls[0]?.id ?? null
  )
  const travelZones = s.travelZones
  const canOffsite = travelZones.length > 1 && service && !service.needsHall
  const [place, setPlace] = useState<'studio' | 'offsite'>('studio')
  const [zoneId, setZoneId] = useState(travelZones[0]?.id ?? null)
  const [date, setDate] = useState(params.get('date') ?? '')
  const [dayCount, setDayCount] = useState(1)
  const [durationH, setDurationH] = useState(Math.max(1, Math.round((service?.durationMin ?? 60) / 60)))
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
  const [created, setCreated] = useState<{ token: string; startMs: number; endMs: number } | null>(null)
  const honeypot = useRef<HTMLInputElement>(null)
  const idemKey = useRef(crypto.randomUUID())

  useEffect(() => {
    setStartMs(null)
  }, [date, serviceId, specialistId, hallId, durationH, place, zoneId, dayCount, people])

  useEffect(() => {
    if (service) setDurationH(Math.max(1, Math.round(service.durationMin / 60)))
  }, [serviceId, service])

  const zone = travelZones.find((z) => z.id === zoneId) ?? null
  const hall = halls.find((h) => h.id === hallId) ?? null
  const offsite = Boolean(canOffsite && place === 'offsite')

  const addonsForMode = bundle.addons.filter((a) => a.appliesTo === mode || a.appliesTo === 'both')

  const estimate = useMemo(() => {
    if (!service) return null
    try {
      return calculatePrice({
        service,
        hall,
        tz: s.tz,
        startUtcMs: startMs ?? Date.now(),
        durationMin: mode === 'rental' ? durationH * 60 : undefined,
        peopleCount: people,
        selectedAddonIds: addonIds,
        addons: bundle.addons,
        travelZone: offsite ? zone : null,
        eveningFrom: s.eveningFrom,
      })
    } catch {
      return null
    }
  }, [service, hall, s.tz, s.eveningFrom, startMs, durationH, mode, people, addonIds, bundle.addons, offsite, zone])

  const dateFrom = date
  const slotsQuery = useQuery({
    queryKey: ['slots', s.slug, serviceId, dateFrom, specialistId, hallId, durationH, place, zoneId, dayCount, people, mode],
    queryFn: () =>
      be.getAvailability({
        slug: s.slug,
        serviceId,
        dateFrom,
        dayCount: service?.multiDayMax > 1 ? dayCount : 1,
        durationMin: mode === 'rental' ? durationH * 60 : undefined,
        specialistId: service?.needsSpecialist ? (specialistId === 'any' ? null : specialistId) : null,
        hallId: service?.needsHall ? hallId : null,
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
    const durationMin = mode === 'rental' ? durationH * 60 : service.durationMin
    const payload: CreateBookingPayload = {
      slug: s.slug,
      kind: mode,
      serviceId: service.id,
      specialistId: service.needsSpecialist ? (specialistId === 'any' ? null : specialistId) : null,
      hallId: service.needsHall ? hallId : null,
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
    const res = await be.createBooking(payload)
    if (res.ok) {
      saveLastToken(s.slug, res.token)
      setCreated({ token: res.token, startMs, endMs: startMs + durationMin * 60_000 })
      setSubmitState('done')
    } else {
      setSubmitError(res.error)
      setSubmitState('idle')
    }
  }

  if (submitState === 'done' && created) {
    const svc = service!
    return (
      <Section>
        <div className="overline">Готово</div>
        <h2>Заявка отправлена</h2>
        <p>
          {svc.autoConfirm
            ? 'Время забронировано автоматически.'
            : 'Владелец подтвердит запись — статус виден в разделе «Моя запись».'}
        </p>
        <div className="card" style={{ maxWidth: 520 }}>
          <div className="sum-row"><span>Услуга</span><b>{svc.name}</b></div>
          <div className="sum-row"><span>Когда</span><b>{humanDate(s.tz, created.startMs)}, {timeInTz(s.tz, created.startMs)}</b></div>
          {estimate && <div className="sum-row"><span>Стоимость</span><b>{money(estimate.total)}</b></div>}
          {estimate && estimate.prepayment > 0 && (
            <div className="sum-row"><span>Предоплата</span><b>{money(estimate.prepayment)}</b></div>
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
          <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
            Напоминание за сутки: пришлём push, если они включены на устройстве; иначе добавьте событие в календарь.
          </p>
        </div>
      </Section>
    )
  }

  return (
    <Section>
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
          <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            {services.map((svc) => (
              <option key={svc.id} value={svc.id}>
                {svc.name} — {svc.priceType === 'fixed' ? money(svc.price) : `от ${money(Math.min(...halls.map((h) => h.rates.weekday.day)))}/час`}
              </option>
            ))}
          </select>
          {service && (
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              {service.deliverableText && <>Состав: {service.includes.join(', ')}. </>}
              {service.deadlineDays > 0 && <>Сдача за {service.deadlineDays} дн. </>}
              Предоплата: {service.prepayment.type === 'percent' ? `${service.prepayment.value}%` : money(service.prepayment.value)}.
            </p>
          )}
        </div>

        {service?.needsSpecialist && activeSpecialists.length > 1 && (
          <div className="field">
            <label>Специалист</label>
            <select value={specialistId} onChange={(e) => setSpecialistId(e.target.value)}>
              <option value="any">Любой свободный</option>
              {activeSpecialists.map((sp) => (
                <option key={sp.id} value={sp.id}>{sp.name} — {sp.title}</option>
              ))}
            </select>
          </div>
        )}

        {service?.needsHall && halls.length > 1 && (
          <div className="field">
            <label>Зал</label>
            <select value={hallId ?? ''} onChange={(e) => setHallId(e.target.value)}>
              {halls.map((h) => (
                <option key={h.id} value={h.id}>{h.name} — до {h.capacity} чел.</option>
              ))}
            </select>
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

        {mode === 'rental' && (
          <div className="field">
            <label>Длительность</label>
            <div className="chips">
              {[1, 2, 3, 4, 6, 8].map((h) => (
                <button type="button" key={h} className={`chip ${durationH === h ? 'active' : ''}`} onClick={() => setDurationH(h)}>
                  {hoursLabel(h)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label>Время {date ? '' : '(сначала выберите дату)'}</label>
          {!date && <p className="small muted">Сначала выберите дату. Занятое время будет перечёркнуто.</p>}
          {date && slotsQuery.isLoading && <p className="small muted">Смотрим свободное время…</p>}
          {date && !slotsQuery.isLoading && !service?.fullDay && (() => {
            const free = new Set((slotsQuery.data ?? []).map((x) => x.startMs))
            const grid = buildSlotGrid(s.schedule, date, 30).map((m) => gridMinutesToMs(s.tz, date, m))
            return (
              <>
                {free.size === 0 && <p className="small muted">На этот день свободного времени нет — выберите другую дату.</p>}
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
              </>
            )
          })()}
          {service?.fullDay && slotsQuery.data?.length ? (
            <div className="slots">
              <button
                type="button"
                className={`slot ${startMs === slotsQuery.data[0].startMs ? 'active' : ''}`}
                onClick={() => setStartMs(slotsQuery.data![0].startMs)}
              >
                весь день · с {timeInTz(s.tz, slotsQuery.data[0].startMs)}
              </button>
            </div>
          ) : null}
        </div>

        <div className="field">
          <label>Количество человек</label>
          <input type="number" min={1} max={50} value={people} onChange={(e) => setPeople(Math.max(1, Number(e.target.value)))} />
        </div>

        {addonsForMode.length > 0 && (
          <div className="field">
            <label>Дополнительно</label>
            {addonsForMode.map((a) => (
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
            <div className="sum-row total"><span>Итого</span><span>{money(estimate.total)}</span></div>
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
      </form>
    </Section>
  )
}
