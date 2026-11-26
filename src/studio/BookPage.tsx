import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { buildFullDayWindows, calculatePrice } from '@/core/price'
import { offsiteRequiredFor } from '@/core/availability'
import { buildSlotGrid, gridMinutesToMs } from '@/core/slotGrid'
import type { CreateBookingPayload } from '@/core/schema'
import type { Hall } from '@/core/types'
import { HallModal } from '@/ui/hallModal'
import { zonedToUtcMs } from '@/core/time'
import { CONTACT_LABELS } from '@/lib/links'
import { uuid } from '@/lib/compat'
import { money, humanDate, timeInTz, hoursLabel, dateInTz, endInTz } from '@/ui/format'
import { ErrorBox, Section } from '@/ui/common'
import { toast } from '@/ui/toast'
import { downloadIcs } from '@/lib/ics'
import { saveBooking } from './bookingStorage'
import PushOptIn from './PushOptIn'

type Mode = 'shoot' | 'rental'

export default function BookPage({ bundle }: { bundle: StudioBundle }) {
  const { settings: s } = bundle
  const [params] = useSearchParams()
  const modes: Mode[] = [s.modes.shoots ? 'shoot' : null, s.modes.rental ? 'rental' : null].filter(Boolean) as Mode[]
  const [mode, setMode] = useState<Mode>(
    params.get('mode') === 'rental' && modes.includes('rental') ? 'rental' : modes[0]
  )
  const services = bundle.services.filter((x) => x.kind === mode).sort((a, b) => a.sort - b.sort)
  const [serviceId, setServiceId] = useState(
    params.get('service') ?? services[0]?.id ?? ''
  )
  const service = services.find((x) => x.id === serviceId) ?? services[0]
  // референсы нужны для съёмки, но не для чистой аренды зала: undefined — авто
  const referencesEnabled = Boolean(service && (service.referencesEnabled ?? service.needsSpecialist))
  const activeSpecialists = bundle.specialists.filter((x) => x.active)
  // только специалисты, разрешённые услугой (белый список; пусто = все)
  const allowedSpecialists = activeSpecialists.filter(
    (sp) => !service?.specialistIds?.length || service.specialistIds.includes(sp.id)
  )
  // Услуга-команда: админ выбрал нескольких, клиент никого не выбирает.
  const teamMode = Boolean(service?.needsSpecialist && service.allSpecialistsRequired)
  const teamSpecialists = teamMode
    ? activeSpecialists.filter((sp) => service?.specialistIds?.includes(sp.id))
    : []
  const [specialistId, setSpecialistId] = useState<string | 'any'>('any')
  // залы, разрешённые для выбранной услуги (белый список + активные)
  const halls = bundle.halls.filter(
    (x) => x.active && (!service?.hallIds?.length || service.hallIds.includes(x.id))
  )
  const hallsKey = halls.map((h) => h.id).join('|')
  const hallChoiceVisible = s.hallChoiceVisible !== false
  // Подсказка в карточке услуги: для почасовой без зала нельзя показывать
  // тариф зала — там платят за специалистов (команда суммируется).
  const priceHintFor = (svc: typeof services[number]) => {
    if (svc.priceType === 'fixed') return money(svc.price)
    const svcHalls = bundle.halls.filter(
      (h) => h.active && (!svc.hallIds?.length || svc.hallIds.includes(h.id))
    )
    const svcNeedHall = svc.needsHall || svc.kind === 'rental'
    const svcSpecs = activeSpecialists.filter(
      (sp) => !svc.specialistIds?.length || svc.specialistIds.includes(sp.id)
    )
    const svcTeam = svc.allSpecialistsRequired
      ? svcSpecs.filter((sp) => svc.specialistIds?.includes(sp.id))
      : []
    if (svc.needsSpecialist) {
      const rates = (svcTeam.length ? svcTeam : svcSpecs)
        .map((sp) => sp.hourRate ?? 0)
        .filter((r) => r > 0)
      const specialistAmount = svcTeam.length
        ? rates.reduce((a, b) => a + b, 0)
        : rates.length ? Math.min(...rates) : 0
      const prefix = svcTeam.length ? '' : 'от '
      if (!svcNeedHall && specialistAmount > 0) return `${prefix}${money(specialistAmount)}/час`
      if (svcNeedHall && svcHalls.length > 0 && specialistAmount > 0) {
        return `${prefix}${money(Math.min(...svcHalls.map((h) => h.rates.weekday.day)))}/час + специалисты`
      }
    }
    if (svcNeedHall && svcHalls.length > 0) {
      return `от ${money(Math.min(...svcHalls.map((h) => h.rates.weekday.day)))}/час`
    }
    if (svcNeedHall) return 'по тарифу зала'
    return 'почасово'
  }
  const defaultHallId =
    service?.defaultHallId && halls.some((h) => h.id === service.defaultHallId)
      ? service.defaultHallId
      : halls[0]?.id ?? null
  const [hallId, setHallId] = useState<string | null>(
    params.get('hall') ?? defaultHallId
  )
  // смена услуги может изменить набор разрешённых залов — выбранное сбрасываем.
  // Дефолтный зал тоже проверяем: он мог остаться вне белого списка после
  // изменения настроек услуги — иначе в заявку уйдёт запрещённый зал.
  useEffect(() => {
    setHallId((prev) => (prev && halls.some((h) => h.id === prev) ? prev : defaultHallId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, hallsKey])
  // Z2: ?service= из URL мог быть услугой другого режима/чужой студии —
  // стейт сбрасываем на фактическую первую услугу, чтобы слоты, UI и сабмит
  // сходились на одном объекте (по образцу санитайзера hallId выше)
  useEffect(() => {
    setServiceId((prev) => (services.some((x) => x.id === prev) ? prev : services[0]?.id ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, services.map((x) => x.id).join('|')])
  // ...и специалистов: запрещённого услугой B сбрасываем на «любого»,
  // иначе stale id уйдёт в заявку с вечной ошибкой «недоступен»
  useEffect(() => {
    setSpecialistId((prev) => (prev !== 'any' && !allowedSpecialists.some((sp) => sp.id === prev) ? 'any' : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId])
  // допуслуги предыдущей услуги не должны уехать в заявку новой
  // (проверка ниже, после вычисления addonsForService)
  const travelZones = s.travelZones
  const hallUsed = Boolean(service && (service.needsHall || service.kind === 'rental'))
  // Специалист без зала — это всегда выезд: не даём выбрать «без места».
  const offsiteOnly = Boolean(service && offsiteRequiredFor(service))
  const canOffsite = travelZones.length > 0 && service && !hallUsed
  const [place, setPlace] = useState<'studio' | 'offsite'>('studio')
  const [zoneId, setZoneId] = useState(travelZones[0]?.id ?? null)
  const [date, setDate] = useState(params.get('date') ?? '')
  const [dayCount, setDayCount] = useState(1)
  const [durationH, setDurationH] = useState(() => {
    const h = Math.max(1, Math.round((service?.durationMin ?? 60) / 60))
    return Math.min(h, 8)
  })
  const [startMs, setStartMs] = useState<number | null>(null)
  // Количество человек держим как строку: type=number с мгновенным
  // Math.max(1, ...) мешал стереть поле — оно сразу возвращалось к единице.
  const [peopleText, setPeopleText] = useState('2')
  // type=number может молча пропускать нажатие буквы: фиксируем попытку,
  // чтобы показать понятную ошибку, а не просто «ничего не произошло».
  const [peopleBadInput, setPeopleBadInput] = useState(false)
  useEffect(() => {
    // maxPeople новой услуги может быть меньше ранее выбранного — иначе сервер
    // молча для клиента отклонит заявку с people больше лимита
    const max = service?.maxPeople ?? 50
    setPeopleText((prev) => (/^\d+$/.test(prev) && Number(prev) > max ? String(max) : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, service?.maxPeople])
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
  const idemKey = useRef(uuid())

  useEffect(() => {
    setStartMs(null)
  }, [date, serviceId, specialistId, hallId, durationH, place, zoneId, dayCount, peopleText])

  useEffect(() => {
    // чипы длительности — только 1–8 ч: при базе >8 ч ни один не был бы активен
    if (service) setDurationH(Math.min(8, Math.max(1, Math.round(service.durationMin / 60))))
  }, [serviceId, service])

  const zone = travelZones.find((z) => z.id === zoneId) ?? null
  const hall = halls.find((h) => h.id === hallId) ?? null
  const maxPeople = service?.maxPeople ?? 50
  const peopleNumber = /^\d+$/.test(peopleText.trim()) ? Number(peopleText.trim()) : null
  // До исправления валидного числа занижаем до 1 только для внутренних расчётов;
  // отправка и запрос слотов при ошибке блокируются ниже.
  const people = peopleNumber !== null && peopleNumber >= 1 ? peopleNumber : 1
  const peopleError =
    peopleBadInput
      ? 'В поле можно вводить только цифры.'
      : peopleNumber === null
        ? 'Укажите количество человек числом.'
        : peopleNumber < 1
          ? 'Количество человек — минимум 1.'
          : peopleNumber > maxPeople
            ? `Количество человек — максимум ${maxPeople}.`
            : null
  const offsite = Boolean(canOffsite && (offsiteOnly || place === 'offsite'))
  // авто-режим выбора зала: сервер сам подбирает свободный разрешённый.
  // Проверяем именно найденный зал, а не сырой id из URL/дефолта: зал мог
  // оказаться вне белого списка услуги.
  const pickHall = Boolean(hallUsed && hallChoiceVisible && hall)
  // многодневная не-fullDay: сервер блокирует и тарифицирует все дни,
  // поэтому окна строим и для неё, а не только для «весь день»
  const multiDay = Boolean(service && service.multiDayMax > 1 && dayCount > 1)

  // допуслуги — только привязанные к выбранной услуге (services.addonIds).
  // Легаси-фолбэка по appliesTo нет: он показывал в аренде зала допы съёмок.
  // Доп с белым списком залов виден только когда выбран подходящий зал;
  // услуга без зала (выезд) такие допы не показывает
  const addonList = service?.addonIds ?? []
  const addonsForService = bundle.addons.filter(
    (a) =>
      addonList.includes(a.id) &&
      (!a.hallIds?.length || (hallUsed && hallId !== null && a.hallIds.includes(hallId)))
  )
  // допы предыдущей услуги/зала не должны уехать в заявку новой
  useEffect(() => {
    const allowed = new Set(addonsForService.map((a) => a.id))
    setAddonIds((prev) => prev.filter((id) => allowed.has(id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, hallId])
  // выбранные референсы не должны уехать в заявку услуги, которой они не нужны
  useEffect(() => {
    if (!referencesEnabled) setRefs([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId])

  // any-режим почасовой услуги со специалистом: сервер подберёт свободного
  // и прибавит его ставку — без неё оценка занижена. Берём минимальную
  // ставку разрешённых и показываем итог как «от …»; точную назовёт сервер.
  const anyEstimate = useMemo(() => {
    if (!service || teamMode || service.priceType !== 'hourly' || !service.needsSpecialist || specialistId !== 'any') return null
    const rates = allowedSpecialists.map((sp) => sp.hourRate ?? 0).filter((r) => r > 0)
    return rates.length ? Math.min(...rates) : null
  }, [service, teamMode, specialistId, allowedSpecialists])

  // B-57: аргументы расчёта цены — отдельно от зала, чтобы оценка могла
  // считаться и без выбранного зала (его подбирает сервер)
  const estimateArgs = useMemo(() => {
    if (!service) return null
    const windowsBased = service.fullDay || multiDay
    const fdStart = windowsBased && startMs ? startMs : null
    return {
      service,
      tz: s.tz,
      // до выбора слота считаем по полдню выбранной даты (иначе тариф
      // выходного/вечера показался бы по «сейчас»)
      startUtcMs: startMs ?? (date ? zonedToUtcMs(s.tz, date, '12:00') : Date.now()),
      durationMin: service.fullDay ? undefined : durationH * 60,
      fullDayWindows:
        windowsBased && date
          ? buildFullDayWindows(s.schedule, s.tz, fdStart ?? zonedToUtcMs(s.tz, date, '12:00'), service.multiDayMax > 1 ? dayCount : 1).windows
          : undefined,
      peopleCount: people,
      selectedAddonIds: addonIds,
      addons: bundle.addons,
      travelZone: offsite ? zone : null,
      eveningFrom: s.eveningFrom,
      // ставки специалистов: команда суммируется, одиночный — явный выбор
      // или минимальная ставка разрешённых (оценка «от»)
      specialists: service.priceType === 'hourly'
        ? (teamMode
            ? teamSpecialists
            : specialistId !== 'any'
              ? allowedSpecialists.filter((x) => x.id === specialistId)
              : anyEstimate !== null
                ? [{ name: 'специалист', hourRate: anyEstimate }]
                : []
          )
            .filter((sp) => (sp.hourRate ?? 0) > 0)
            .map((sp) => ({ name: sp.name, hourRate: sp.hourRate! }))
        : null,
    }
  }, [service, s.tz, s.schedule, s.eveningFrom, startMs, date, durationH, specialistId, allowedSpecialists, teamMode, teamSpecialists, mode, people, peopleError, addonIds, bundle.addons, offsite, zone, dayCount, multiDay, anyEstimate])

  const estimate = useMemo(() => {
    if (!service || !estimateArgs) return null
    try {
      return calculatePrice({ ...estimateArgs, hall: hallUsed ? hall : null })
    } catch {
      return null
    }
  }, [service, estimateArgs, hall, hallUsed])

  // B-57: зал подбирает сервер (выбор зала скрыт — pickHall ложен), а тарифы
  // разрешённых залов разные: показываем минимум как «от», точную цену назовёт сервер
  const hallAutoRange = useMemo(() => {
    if (!service || !hallUsed || pickHall || !estimateArgs) return null
    const allowed = halls.filter((h) => h.active && (!service.hallIds?.length || service.hallIds.includes(h.id)))
    if (allowed.length < 2) return null
    try {
      const totals = allowed.map((h) => calculatePrice({ ...estimateArgs, hall: h }).total)
      return { min: Math.min(...totals), max: Math.max(...totals) }
    } catch {
      return null
    }
  }, [service, hallUsed, pickHall, estimateArgs, halls])

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
        specialistId: service?.needsSpecialist && !teamMode ? (specialistId === 'any' ? null : specialistId) : null,
        hallId: hallUsed && pickHall ? hall?.id ?? null : null,
        offsite,
        travelZoneId: offsite ? zoneId : null,
        peopleCount: people,
      }),
    enabled: Boolean(dateFrom && service) && !peopleError && !(offsiteOnly && !zone),
  })

  function onRefsChange(files: FileList | null) {
    // Y3: референсы грузятся после создания заявки по токену из ответа (до 5
    // файлов); ошибка загрузки не отменяет заявку
    if (!files) return
    setRefs(Array.from(files).slice(0, 5))
  }

  // B-45: список способов связи без дублей и с человеческими подписями:
  // «Звонок» первым, затем способы студии (подписи CONTACT_LABELS; phone
  // пропускаем — он уже есть), затем telegram/whatsapp/max — только те,
  // которых ещё нет в списке. Дедуп по value: раньше у студии с настроенным
  // Telegram было два option — сырой «telegram» из настроек и хардкодный
  const contactOptions = (() => {
    const seen = new Set<string>()
    const list: { value: typeof method; label: string }[] = []
    const push = (value: typeof method, label: string) => {
      if (seen.has(value)) return
      seen.add(value)
      list.push({ value, label })
    }
    push('phone', 'Звонок')
    s.contactMethods.forEach((m) => push(m.type, CONTACT_LABELS[m.type] ?? m.type))
    ;(['telegram', 'whatsapp', 'max'] as const).forEach((t) => push(t, CONTACT_LABELS[t]))
    return list
  })()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    if (!service || !startMs || peopleError || (offsiteOnly && !zone)) return
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
      specialistId: service.needsSpecialist && !teamMode ? (specialistId === 'any' ? null : specialistId) : null,
      hallId: hallUsed && pickHall ? hall?.id ?? null : null,
      startUtcMs: startMs,
      durationMin,
      dayCount: service.multiDayMax > 1 ? dayCount : 1,
      peopleCount: people,
      offsite,
      travelZoneId: offsite ? zoneId : null,
      addonIds,
      client: { name, phone, method, notes: notes || undefined, referenceCount: referencesEnabled && refs.length ? refs.length : undefined },
      consent,
      honeypot: honeypot.current?.value ?? '',
      idempotencyKey: idemKey.current,
    }
    try {
      const res = await be.createBooking(payload)
      if (res.ok) {
        // Секрет заявки сервер возвращает один раз — сохраняем его на устройстве,
        // чтобы «Моя запись» открывалась и после закрытия вкладки.
        if (res.token) {
          saveBooking(s.slug, { token: res.token, serviceName: service.name, startsAtMs: startMs, createdAtMs: Date.now() })
        }
        // B-58: при дубликате сервер токен не возвращает. Подставлять «последний
        // токен устройства» нельзя: это может быть другая заявка — экран успеха
        // показал бы чужую ссылку, а референсы ушли бы к той заявке
        const duplicate = Boolean((res as { duplicate?: boolean }).duplicate)
        const effectiveToken = duplicate ? '' : res.token
        // Y3: референсы грузим после создания брони — фича необязательная,
        // ошибка загрузки не должна портить экран успеха
        if (!duplicate && referencesEnabled && refs.length > 0 && effectiveToken && be.uploadBookingReferences) {
          try {
            await be.uploadBookingReferences(s.slug, effectiveToken, refs)
          } catch (e) {
            // заявка уже создана — экран успеха не портим, но клиент должен узнать,
            // что референсы не дошли (например, файл больше лимита)
            toast(`Референсы не загрузились: ${e instanceof Error ? e.message : 'неизвестная ошибка'}`, 'warn')
          }
        }
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
          <div className="sum-row"><span>Когда</span><b>{humanDate(s.tz, created.startMs)}, {timeInTz(s.tz, created.startMs)}–{endInTz(s.tz, created.startMs, created.endMs)}</b></div>
          {/* B-58: у дубликата серверной цены нет — оценка не подтверждена */}
          {finalPrice && (
            <div className="sum-row"><span>{created.price ? 'Стоимость' : 'Предварительная стоимость'}</span><b>{money(finalPrice.total)}</b></div>
          )}
          {finalPrice && finalPrice.prepayment > 0 && (
            <div className="sum-row"><span>Предоплата</span><b>{money(finalPrice.prepayment)}</b></div>
          )}
          {created.token !== '' ? (
            <>
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
              <PushOptIn slug={s.slug} token={created.token} />
            </>
          ) : (
            <p className="muted">Эта заявка уже была создана ранее. Ссылка для управления ею была в первом подтверждении.</p>
          )}
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

      {modes.length > 1 && bundle.services.some((x) => x.kind === 'shoot') && bundle.services.some((x) => x.kind === 'rental') && (
        <div className="chips" style={{ marginBottom: 20 }}>
          <button aria-pressed={mode === 'shoot'} className={`chip ${mode === 'shoot' ? 'active' : ''}`} onClick={() => { setMode('shoot'); const first = bundle.services.find((x) => x.kind === 'shoot'); if (first) setServiceId(first.id) }}>
            Съёмка
          </button>
          <button aria-pressed={mode === 'rental'} className={`chip ${mode === 'rental' ? 'active' : ''}`} onClick={() => { setMode('rental'); const first = bundle.services.find((x) => x.kind === 'rental'); if (first) setServiceId(first.id) }}>
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
                    {priceHintFor(svc)}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {service && (
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              {service.includes.length > 0 && <>Состав: {service.includes.join(', ')}. </>}
              {service.deadlineDays > 0 && <>Сдача за {service.deadlineDays} дн. </>}
              Предоплата: {service.prepayment.type === 'percent' ? `${service.prepayment.value}%` : money(service.prepayment.value)}.
              {hallUsed && halls.length > 0 && (service.priceType === 'hourly'
                ? ' + зал по тарифу зала (строка в «Итого»).'
                : ' Зал включён в стоимость.')}
              {service.priceType === 'hourly' && service.needsSpecialist
                ? teamMode
                  ? ' Ставки всех специалистов команды — отдельными строками в «Итого».'
                  : ' Ставка специалиста — отдельной строкой в «Итого».'
                : ''}
            </p>
          )}
        </div>

        {teamMode && (
          <p className="small muted" style={{ margin: '0 0 8px' }}>
            {teamSpecialists.length > 0 ? (
              <>
                Съёмку проведут: {teamSpecialists.map((sp) => (
                  <span key={sp.id}>
                    <b>{sp.name}</b>
                    {service.priceType === 'hourly' && sp.hourRate
                      ? ` (+${money(sp.hourRate)}/час)`
                      : ''}
                    {sp.id !== teamSpecialists[teamSpecialists.length - 1].id ? ', ' : ''}
                  </span>
                ))}.
              </>
            ) : (
              'В услуге не настроены специалисты — запись временно недоступна.'
            )}
          </p>
        )}
        {service?.needsSpecialist && !teamMode && allowedSpecialists.length > 1 && s.specialistChoiceVisible !== false && (
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
        {service?.needsSpecialist && !teamMode && allowedSpecialists.length > 1 && s.specialistChoiceVisible === false && (
          <p className="small muted" style={{ margin: '0 0 8px' }}>Специалист подберётся автоматически — свободный на выбранное время.</p>
        )}
        {service?.needsSpecialist && !teamMode && allowedSpecialists.length === 1 && (
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

        {offsiteOnly && (
          <div className="field">
            <label htmlFor="offsite-zone">Зона выезда</label>
            {travelZones.length > 0 ? (
              <>
                <select
                  id="offsite-zone"
                  value={zoneId ?? ''}
                  onChange={(e) => setZoneId(e.target.value)}
                >
                  {travelZones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}{z.extraFee ? ` (+${money(z.extraFee)})` : ''}
                    </option>
                  ))}
                </select>
                <p className="small muted" style={{ margin: '4px 0 0' }}>
                  Услуга со специалистом проводится только на выезде. Дорога блокирует время специалиста.
                </p>
              </>
            ) : (
              <p className="small" style={{ color: 'var(--bad)', margin: 0 }} role="alert">
                У студии не настроены зоны выезда — запись недоступна.
              </p>
            )}
          </div>
        )}

        {canOffsite && !offsiteOnly && (
          <div className="field">
            <label>Где проходит съёмка</label>
            <select value={place} onChange={(e) => setPlace(e.target.value as 'studio' | 'offsite')}>
              <option value="studio">Без выезда</option>
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
          {/* Z2: min — сегодня по времени студии, не UTC: после 21:00 МСК UTC-полночь
              разблокировала бы выбор уже прошедшей локальной даты */}
          <input type="date" required value={date} min={dateInTz(s.tz, Date.now())} onChange={(e) => setDate(e.target.value)} />
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

        {service && !service.fullDay && !multiDay && (
          <div className="field">
            <label>Длительность</label>
            <div className="chips">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((h) => (
                <button type="button" key={h} aria-pressed={durationH === h} className={`chip ${durationH === h ? 'active' : ''}`} onClick={() => setDurationH(h)}>
                  {hoursLabel(h)}
                </button>
              ))}
            </div>
          </div>
        )}

        {service && !service.fullDay && multiDay && service.priceType === 'hourly' && (
          <p className="small muted" style={{ margin: '0 0 8px' }}>
            Многодневная аренда занимает и тарифицирует полные часы работы студии во все дни.
          </p>
        )}

        <div className="field">
          <label>Время {date ? '' : '(сначала выберите дату)'}</label>
          {date && service && !service.fullDay && (
            <p className="small muted" style={{ margin: '0 0 8px' }}>
              Длительность брони: {hoursLabel(durationH)}. Каждая кнопка — время начала, занято будет всё время брони.{startMs !== null && startMs + durationH * 3_600_000 > 0 && dateInTz(s.tz, startMs) !== dateInTz(s.tz, startMs + durationH * 3_600_000) ? ' Бронь закончится на следующие сутки.' : ''}
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
            const gridMin = buildSlotGrid(s.schedule, date, 30)
            const grid = gridMin.map((m) => gridMinutesToMs(s.tz, date, m))
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
                    {grid.map((m, i) => {
                      // Z2: слоты после полуночи — это следующие сутки (ночная смена);
                      // без разделителя «01:00» под датой «пятница» вводит в заблуждение
                      // признак ночи — по минутам сетки (>= 1440 — следующие сутки),
                      // а не по epoch-миллисекундам: иначе «ночь» стояла над первым слотом каждого дня
                      const night = gridMin[i] >= 1440
                      const prevNight = i > 0 && gridMin[i - 1] >= 1440
                      const ms = m
                      return (
                        <Fragment key={ms}>
                          {night && !prevNight && (
                            <span className="slot-night-sep small muted">ночь след. дня ↓</span>
                          )}
                          <button
                            type="button"
                            aria-pressed={startMs === ms}
                            className={`slot ${startMs === ms ? 'active' : ''}`}
                            disabled={!free.has(ms)}
                            onClick={() => setStartMs(ms)}
                          >
                            {timeInTz(s.tz, ms)}
                          </button>
                        </Fragment>
                      )
                    })}
                  </div>
                )}
                {grid.length > 0 && free.size > 0 && free.size < grid.length && (
                  <p className="small muted" style={{ marginTop: 8 }}>Перечёркнутое время недоступно для выбранной длительности (занято или не помещается до закрытия).</p>
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
                    {fdw.windows[0]?.open}–{fdw.windows[fdw.windows.length - 1]?.close}
                    {/* Z2: ночное окно — та же пометка, что в scheduleRows витрины */}
                    {fdw.windows[fdw.windows.length - 1]!.close <= fdw.windows[fdw.windows.length - 1]!.open ? ' (до следующего дня)' : ''} · {hoursLabel(fdHours)} зала
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
          <label htmlFor="people-count">Количество человек{service?.maxPeople ? ` (максимум ${service.maxPeople})` : ''}</label>
          <input
            id="people-count"
            type="number"
            min={1}
            max={maxPeople}
            step={1}
            autoComplete="off"
            value={peopleText}
            aria-invalid={Boolean(peopleError)}
            aria-describedby={peopleError ? 'people-count-error' : undefined}
            onChange={(e) => {
              // B-21: допустимый ввод (цифры или очистка поля) снимает залипший
              // флаг «только цифры»; иначе он держится от прошлого нажатия
              setPeopleBadInput(/^\d*$/.test(e.currentTarget.value) ? false : e.currentTarget.validity.badInput)
              setPeopleText(e.target.value)
            }}
            onBlur={() => setPeopleBadInput(false)}
            onKeyDown={(e) => {
              if (e.key.length === 1 && !/\d/.test(e.key)) setPeopleBadInput(true)
            }}
          />
          {peopleError && (
            <p id="people-count-error" className="small" style={{ color: 'var(--bad)', margin: '4px 0 0' }} role="alert">
              {peopleError}
            </p>
          )}
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

        {referencesEnabled && (
          <div className="field">
            <label>Референсы (до 5 изображений)</label>
            <input type="file" accept="image/*" multiple onChange={(e) => onRefsChange(e.target.files)} />
            {refs.length > 0 && <p className="small muted">Выбрано: {refs.length}. Изображения отправятся владельцу вместе с заявкой.</p>}
          </div>
        )}

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
            {contactOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {estimate && (
          <div className="summary" style={{ marginBottom: 16 }}>
            {estimate.lines.map((l, i) => (
              <div className="sum-row" key={i}><span>{l.label}</span><span>{money(l.amount)}</span></div>
            ))}
            <div className="sum-row total">
              <span>Итого</span>
              <span>
                {hallAutoRange !== null && hallAutoRange.max !== hallAutoRange.min
                  ? `от ${money(anyEstimate !== null ? estimate.total : hallAutoRange.min)}`
                  : anyEstimate !== null
                    ? `от ${money(estimate.total)}`
                    : money(estimate.total)}
              </span>
            </div>
            {anyEstimate !== null && (
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                точная ставка специалиста зависит от того, кто свободен
              </p>
            )}
            {hallAutoRange !== null && hallAutoRange.max !== hallAutoRange.min && (
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                точная цена зависит от того, какой зал свободен
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

        <button className="btn btn-primary btn-block" disabled={!consent || !startMs || Boolean(peopleError) || (offsiteOnly && !zone) || submitState === 'sending'}>
          {submitState === 'sending' ? 'Отправляем…' : 'Отправить заявку'}
        </button>
        {!startMs && (
          <p className="small muted" style={{ margin: '8px 0 0', textAlign: 'center' }}>
            {date
              ? 'Выберите свободное время в блоке «Время» выше — без него заявку отправить нельзя.'
              : 'Выберите дату и свободное время — без них заявку отправить нельзя.'}
          </p>
        )}
        {peopleError && (
          <p className="small" style={{ color: 'var(--bad)', margin: '8px 0 0', textAlign: 'center' }} role="alert">
            Исправьте количество человек — заявка не отправится.
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
