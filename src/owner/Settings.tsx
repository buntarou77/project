import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { Section } from '@/ui/common'
import { WEEKDAY_ORDER, WEEKDAY_RU, money } from '@/ui/format'
import { env } from '@/lib/env'
import type { WeekSchedule } from '@/core/types'

type S = StudioBundle['settings']
type Specialist = StudioBundle['specialists'][number]
type Hall = StudioBundle['halls'][number]
type Service = StudioBundle['services'][number]
type Addon = StudioBundle['addons'][number]

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  )
}

function SpecialistsEditor({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, Partial<Specialist>>>({})
  const upd = (id: string, patch: Partial<Specialist>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  async function save(sp: Specialist) {
    await be.ownerUpsertSpecialist(slug, { ...sp, ...(draft[sp.id] ?? {}) } as Specialist)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
  }
  return (
    <>
      {bundle.specialists.map((sp) => (
        <div className="card" key={sp.id} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 2, minWidth: 140, marginBottom: 0 }}>
              <label>Имя</label>
              <input defaultValue={sp.name} onChange={(e) => upd(sp.id, { name: e.target.value })} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 100, marginBottom: 0 }}>
              <label>Роль</label>
              <input defaultValue={sp.title} onChange={(e) => upd(sp.id, { title: e.target.value })} />
            </div>
            <div className="field" style={{ width: 90, marginBottom: 0 }}>
              <label>Съёмок/день</label>
              <input type="number" min={1} max={10} defaultValue={sp.dayLimit} onChange={(e) => upd(sp.id, { dayLimit: Number(e.target.value) })} />
            </div>
            <button className="btn btn-sm btn-primary" onClick={() => save(sp)}>Сохранить</button>
            <button className="btn btn-sm" onClick={async () => { await be.ownerUpsertSpecialist(slug, { ...sp, active: !sp.active }); qc.invalidateQueries({ queryKey: ['studio', slug] }) }}>
              {sp.active ? 'Отключить' : 'Включить'}
            </button>
          </div>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => save({ id: `sp-${Date.now()}`, name: 'Новый специалист', title: '', active: true, dayLimit: 2 })}>
        + Специалист
      </button>
    </>
  )
}

function HallsEditor({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, Partial<Hall>>>({})
  const upd = (id: string, patch: Partial<Hall>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  async function save(h: Hall) {
    const merged = { ...h, ...(draft[h.id] ?? {}) } as Hall
    await be.ownerUpsertHall(slug, merged)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
  }
  return (
    <>
      {bundle.halls.map((h) => (
        <div className="card" key={h.id} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 2, minWidth: 120, marginBottom: 0 }}>
              <label>Название</label>
              <input defaultValue={h.name} onChange={(e) => upd(h.id, { name: e.target.value })} />
            </div>
            <div className="field" style={{ width: 90, marginBottom: 0 }}>
              <label>Вместимость</label>
              <input type="number" min={1} defaultValue={h.capacity} onChange={(e) => upd(h.id, { capacity: Number(e.target.value) })} />
            </div>
            <div className="field" style={{ width: 110, marginBottom: 0 }}>
              <label>Будни день</label>
              <input type="number" defaultValue={h.rates.weekday.day} onChange={(e) => upd(h.id, { rates: { ...h.rates, weekday: { ...h.rates.weekday, day: Number(e.target.value) } } })} />
            </div>
            <div className="field" style={{ width: 110, marginBottom: 0 }}>
              <label>Будни вечер</label>
              <input type="number" defaultValue={h.rates.weekday.evening} onChange={(e) => upd(h.id, { rates: { ...h.rates, weekday: { ...h.rates.weekday, evening: Number(e.target.value) } } })} />
            </div>
            <div className="field" style={{ width: 110, marginBottom: 0 }}>
              <label>Вых. день</label>
              <input type="number" defaultValue={h.rates.weekend.day} onChange={(e) => upd(h.id, { rates: { ...h.rates, weekend: { ...h.rates.weekend, day: Number(e.target.value) } } })} />
            </div>
            <div className="field" style={{ width: 110, marginBottom: 0 }}>
              <label>Вых. вечер</label>
              <input type="number" defaultValue={h.rates.weekend.evening} onChange={(e) => upd(h.id, { rates: { ...h.rates, weekend: { ...h.rates.weekend, evening: Number(e.target.value) } } })} />
            </div>
            <button className="btn btn-sm btn-primary" onClick={() => save(h)}>Сохранить</button>
            <button className="btn btn-sm" onClick={async () => { await be.ownerUpsertHall(slug, { ...h, active: !h.active }); qc.invalidateQueries({ queryKey: ['studio', slug] }) }}>
              {h.active ? 'Отключить' : 'Включить'}
            </button>
          </div>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => save({ id: `hall-${Date.now()}`, name: 'Новый зал', capacity: 6, rates: { weekday: { day: 1000, evening: 1300 }, weekend: { day: 1400, evening: 1600 } }, active: true })}>
        + Зал
      </button>
    </>
  )
}

function ServicesEditor({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, Partial<Service>>>({})
  const upd = (id: string, patch: Partial<Service>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  async function save(svc: Service) {
    await be.ownerUpsertService(slug, { ...svc, ...(draft[svc.id] ?? {}) } as Service)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
  }
  async function del(svc: Service) {
    if (!confirm(`Удалить услугу «${svc.name}»? Активные брони не пострадают.`)) return
    await be.ownerDeleteService(slug, svc.id)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
  }
  const sorted = [...bundle.services].sort((a, b) => a.sort - b.sort)
  return (
    <>
      {sorted.map((svc) => (
        <details className="card" key={svc.id} style={{ marginBottom: 10 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
            {svc.name} · {svc.priceType === 'fixed' ? money(svc.price) : 'почасово'} · {svc.kind === 'shoot' ? 'съёмка' : 'аренда'}
          </summary>
          <div className="grid grid-2" style={{ marginTop: 12 }}>
            <Row label="Название"><input defaultValue={svc.name} onChange={(e) => upd(svc.id, { name: e.target.value })} /></Row>
            <Row label="Описание"><input defaultValue={svc.description} onChange={(e) => upd(svc.id, { description: e.target.value })} /></Row>
            <Row label="Цена, ₽ (для фиксированной)"><input type="number" defaultValue={svc.price} onChange={(e) => upd(svc.id, { price: Number(e.target.value) })} /></Row>
            <Row label="Длительность, мин"><input type="number" min={30} step={30} defaultValue={svc.durationMin} onChange={(e) => upd(svc.id, { durationMin: Number(e.target.value) })} /></Row>
            <Row label="Что входит (по строке)"><textarea defaultValue={svc.includes.join('\n')} onChange={(e) => upd(svc.id, { includes: e.target.value.split('\n').filter(Boolean) })} /></Row>
            <Row label="Результат (что сдаёте)"><input defaultValue={svc.deliverableText} onChange={(e) => upd(svc.id, { deliverableText: e.target.value })} /></Row>
            <Row label="Срок сдачи, дней"><input type="number" min={0} defaultValue={svc.deadlineDays} onChange={(e) => upd(svc.id, { deadlineDays: Number(e.target.value) })} /></Row>
            <Row label="Предоплата">
              <div style={{ display: 'flex', gap: 8 }}>
                <select defaultValue={svc.prepayment.type} onChange={(e) => upd(svc.id, { prepayment: { ...svc.prepayment, type: e.target.value as 'percent' | 'amount' } })}>
                  <option value="percent">%</option>
                  <option value="amount">₽</option>
                </select>
                <input type="number" min={0} defaultValue={svc.prepayment.value} onChange={(e) => upd(svc.id, { prepayment: { ...svc.prepayment, value: Number(e.target.value) } })} />
              </div>
            </Row>
            <Row label="Подготовка/уборка, мин">
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" min={0} defaultValue={svc.setupMin} onChange={(e) => upd(svc.id, { setupMin: Number(e.target.value) })} />
                <input type="number" min={0} defaultValue={svc.cleanupMin} onChange={(e) => upd(svc.id, { cleanupMin: Number(e.target.value) })} />
              </div>
            </Row>
            <Row label="Ресурсы и режимы">
              <label className="checkline"><input type="checkbox" defaultChecked={svc.needsSpecialist} onChange={(e) => upd(svc.id, { needsSpecialist: e.target.checked })} /><span>нужен специалист</span></label>
              <label className="checkline"><input type="checkbox" defaultChecked={svc.needsHall} onChange={(e) => upd(svc.id, { needsHall: e.target.checked })} /><span>нужен зал</span></label>
              <label className="checkline"><input type="checkbox" defaultChecked={svc.fullDay} onChange={(e) => upd(svc.id, { fullDay: e.target.checked })} /><span>весь день</span></label>
              <label className="checkline"><input type="checkbox" defaultChecked={svc.autoConfirm} onChange={(e) => upd(svc.id, { autoConfirm: e.target.checked })} /><span>автоподтверждение</span></label>
            </Row>
            <Row label="Макс. дней (многодневная)"><input type="number" min={1} max={5} defaultValue={svc.multiDayMax} onChange={(e) => upd(svc.id, { multiDayMax: Number(e.target.value) })} /></Row>
            <Row label="Порядок"><input type="number" defaultValue={svc.sort} onChange={(e) => upd(svc.id, { sort: Number(e.target.value) })} /></Row>
          </div>
          <div className="chips">
            <button className="btn btn-sm btn-primary" onClick={() => save(svc)}>Сохранить услугу</button>
            <button className="btn btn-sm" onClick={() => del(svc)}>Удалить</button>
          </div>
        </details>
      ))}
      <button
        className="btn btn-sm"
        onClick={() =>
          save({
            id: `svc-${Date.now()}`, kind: 'shoot', name: 'Новая услуга', description: '',
            priceType: 'fixed', price: 5000, durationMin: 60, includes: ['1 час съёмки'],
            deliverableText: '10 кадров', deadlineDays: 5, prepayment: { type: 'percent', value: 30 },
            needsSpecialist: true, needsHall: false, fullDay: false, multiDayMax: 1,
            autoConfirm: false, setupMin: 0, cleanupMin: 0, sort: bundle.services.length + 1,
          })
        }
      >
        + Услуга
      </button>
    </>
  )
}

function AddonsEditor({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, Partial<Addon>>>({})
  const upd = (id: string, patch: Partial<Addon>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  async function save(a: Addon) {
    await be.ownerUpsertAddon(slug, { ...a, ...(draft[a.id] ?? {}) } as Addon)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
  }
  return (
    <>
      {bundle.addons.map((a) => (
        <div className="card" key={a.id} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 2, minWidth: 140, marginBottom: 0 }}>
              <label>Название</label>
              <input defaultValue={a.name} onChange={(e) => upd(a.id, { name: e.target.value })} />
            </div>
            <div className="field" style={{ width: 100, marginBottom: 0 }}>
              <label>Цена, ₽</label>
              <input type="number" min={0} defaultValue={a.price} onChange={(e) => upd(a.id, { price: Number(e.target.value) })} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Единица</label>
              <select defaultValue={a.unit} onChange={(e) => upd(a.id, { unit: e.target.value as Addon['unit'] })}>
                <option value="booking">за бронь</option>
                <option value="hour">за час</option>
                <option value="person">за человека</option>
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>К чему</label>
              <select defaultValue={a.appliesTo} onChange={(e) => upd(a.id, { appliesTo: e.target.value as Addon['appliesTo'] })}>
                <option value="shoot">съёмки</option>
                <option value="rental">аренда</option>
                <option value="both">всё</option>
              </select>
            </div>
            <button className="btn btn-sm btn-primary" onClick={() => save(a)}>Сохранить</button>
            <button className="btn btn-sm" onClick={async () => { await be.ownerDeleteAddon(slug, a.id); qc.invalidateQueries({ queryKey: ['studio', slug] }) }}>Удалить</button>
          </div>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => save({ id: `ad-${Date.now()}`, name: 'Новая допуслуга', price: 500, unit: 'booking', appliesTo: 'both' })}>
        + Допуслуга
      </button>
    </>
  )
}

export default function OwnerSettings({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const [s, setS] = useState<S>(structuredClone(bundle.settings))
  const [saved, setSaved] = useState(false)
  const [newClosed, setNewClosed] = useState('')
  const [newReview, setNewReview] = useState({ author: '', rating: 5, text: '' })
  const [icalToken, setIcalToken] = useState<string | null>(null)
  const qc = useQueryClient()
  const set = (patch: Partial<S>) => {
    setS((prev) => ({ ...prev, ...patch }))
    setSaved(false)
  }

  useEffect(() => {
    be.ownerCalendarToken(slug).then(setIcalToken).catch(() => setIcalToken(null))
  }, [slug])

  function setDay(key: keyof WeekSchedule, value: string | null) {
    setS((prev) => ({
      ...prev,
      schedule: { ...prev.schedule, [key]: value === null ? null : { open: value.split('-')[0], close: value.split('-')[1] } },
    }))
    setSaved(false)
  }

  async function save() {
    await be.ownerSaveSettings(slug, s)
    setSaved(true)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
  }

  const icalUrl = icalToken && env.VITE_SUPABASE_URL
    ? `${env.VITE_SUPABASE_URL}/functions/v1/ics?slug=${slug}&token=${icalToken}`
    : null

  return (
    <Section>
      <h2>Настройки студии</h2>
      <div className="grid grid-2">
        <div>
          <Row label="Название"><input type="text" value={s.name} onChange={(e) => set({ name: e.target.value })} /></Row>
          <Row label="Слоган"><input type="text" value={s.tagline} onChange={(e) => set({ tagline: e.target.value })} /></Row>
          <Row label="Описание"><textarea value={s.description} onChange={(e) => set({ description: e.target.value })} /></Row>
          <Row label="Город"><input type="text" value={s.city} onChange={(e) => set({ city: e.target.value })} /></Row>
          <Row label="Адрес"><input type="text" value={s.address} onChange={(e) => set({ address: e.target.value })} /></Row>
          <Row label="Ссылка на Яндекс Карты"><input type="url" value={s.mapsUrl} onChange={(e) => set({ mapsUrl: e.target.value })} /></Row>
          <Row label="Телефон"><input type="tel" value={s.phone} onChange={(e) => set({ phone: e.target.value })} /></Row>
        </div>
        <div>
          <Row label="Акцентный цвет"><input type="color" value={s.accent} onChange={(e) => set({ accent: e.target.value })} style={{ width: 80, height: 40 }} /></Row>
          <Row label="Тема">
            <select value={s.theme} onChange={(e) => set({ theme: e.target.value as S['theme'] })}>
              <option value="light">Светлая</option>
              <option value="dark">Тёмная</option>
              <option value="auto">Как у устройства</option>
            </select>
          </Row>
          <Row label="Вечерний тариф с"><input type="time" value={s.eveningFrom} onChange={(e) => set({ eveningFrom: e.target.value })} /></Row>
          <Row label="Бесплатная отмена за (часов)"><input type="number" min={0} max={336} value={s.cancellation.freeHours} onChange={(e) => set({ cancellation: { ...s.cancellation, freeHours: Number(e.target.value) } })} /></Row>
          <Row label="Текст правил отмены"><textarea value={s.cancellation.text} onChange={(e) => set({ cancellation: { ...s.cancellation, text: e.target.value } })} /></Row>
          <Row label="Режимы">
            <div className="checkline"><input type="checkbox" checked={s.modes.shoots} onChange={(e) => set({ modes: { ...s.modes, shoots: e.target.checked } })} /><span>Съёмки</span></div>
            <div className="checkline"><input type="checkbox" checked={s.modes.rental} onChange={(e) => set({ modes: { ...s.modes, rental: e.target.checked } })} /><span>Аренда студии</span></div>
          </Row>
          <Row label="Отзывы">
            <div className="checkline"><input type="checkbox" checked={s.reviewsEnabled} onChange={(e) => set({ reviewsEnabled: e.target.checked })} /><span>Показывать блок отзывов</span></div>
          </Row>
        </div>
      </div>

      <h3>График работы ({s.tz})</h3>
      <div className="grid grid-2" style={{ marginBottom: 18 }}>
        {WEEKDAY_ORDER.map((k) => (
          <Row key={k} label={WEEKDAY_RU[k]}>
            <select
              value={s.schedule[k] ? `${s.schedule[k]!.open}-${s.schedule[k]!.close}` : ''}
              onChange={(e) => setDay(k, e.target.value || null)}
            >
              <option value="">Выходной</option>
              {['09:00-21:00', '10:00-20:00', '10:00-21:00', '11:00-20:00', '09:00-18:00'].map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </Row>
        ))}
      </div>

      <h3>Закрытые даты (праздники, отпуск)</h3>
      <div className="chips" style={{ marginBottom: 10 }}>
        {s.closedDates.map((d) => (
          <span key={d} className="chip" style={{ cursor: 'default' }}>
            {d}{' '}
            <button type="button" onClick={() => set({ closedDates: s.closedDates.filter((x) => x !== d) })} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit' }}>✕</button>
          </span>
        ))}
        {s.closedDates.length === 0 && <span className="muted small">нет</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <input type="date" value={newClosed} onChange={(e) => setNewClosed(e.target.value)} />
        <button
          className="btn btn-sm"
          onClick={() => {
            if (newClosed && !s.closedDates.includes(newClosed)) set({ closedDates: [...s.closedDates, newClosed].sort() })
            setNewClosed('')
          }}
        >
          Добавить
        </button>
      </div>

      <h3>Информационные карточки</h3>
      {s.infoCards.map((c, i) => (
        <div className="card" key={i} style={{ marginBottom: 10 }}>
          <Row label={`Заголовок ${i + 1}`}><input type="text" value={c.title} onChange={(e) => { const cards = [...s.infoCards]; cards[i] = { ...c, title: e.target.value }; set({ infoCards: cards }) }} /></Row>
          <Row label="Текст"><textarea value={c.text} onChange={(e) => { const cards = [...s.infoCards]; cards[i] = { ...c, text: e.target.value }; set({ infoCards: cards }) }} /></Row>
        </div>
      ))}

      <h3>Отзывы</h3>
      <p className="small muted">Отзывы добавляете только вы — вручную, с согласия автора.</p>
      {s.reviews.map((r, i) => (
        <div className="card" key={i} style={{ marginBottom: 8 }}>
          <div className="booking-row">
            <span><strong>{r.author}</strong> <span className="muted">{'★'.repeat(r.rating)}</span></span>
            <button className="btn btn-sm" onClick={() => set({ reviews: s.reviews.filter((_, j) => j !== i) })}>Удалить</button>
          </div>
          <p className="small" style={{ margin: 0 }}>{r.text}</p>
        </div>
      ))}
      <div className="card" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}><label>Автор</label><input value={newReview.author} onChange={(e) => setNewReview({ ...newReview, author: e.target.value })} /></div>
          <div className="field" style={{ marginBottom: 0, width: 90 }}><label>Оценка</label><input type="number" min={1} max={5} value={newReview.rating} onChange={(e) => setNewReview({ ...newReview, rating: Number(e.target.value) })} /></div>
          <div className="field" style={{ marginBottom: 0, flex: 1 }}><label>Текст</label><input value={newReview.text} onChange={(e) => setNewReview({ ...newReview, text: e.target.value })} /></div>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              if (newReview.author && newReview.text) {
                set({ reviews: [...s.reviews, newReview] })
                setNewReview({ author: '', rating: 5, text: '' })
              }
            }}
          >
            Добавить
          </button>
        </div>
      </div>

      <h3>Специалисты</h3>
      <div style={{ marginBottom: 18 }}><SpecialistsEditor bundle={bundle} slug={slug} /></div>

      {bundle.halls.length > 0 && (
        <>
          <h3>Залы и тарифы</h3>
          <div style={{ marginBottom: 18 }}><HallsEditor bundle={bundle} slug={slug} /></div>
        </>
      )}

      <h3>Услуги и пакеты</h3>
      <div style={{ marginBottom: 18 }}><ServicesEditor bundle={bundle} slug={slug} /></div>

      <h3>Допуслуги</h3>
      <div style={{ marginBottom: 18 }}><AddonsEditor bundle={bundle} slug={slug} /></div>

      <h3>Календарь-подписка (iCal)</h3>
      {icalUrl ? (
        <div className="card" style={{ marginBottom: 18 }}>
          <p className="small muted" style={{ marginBottom: 6 }}>Только чтение, секретный токен. Добавьте URL в Google/Apple Calendar:</p>
          <code className="small" style={{ wordBreak: 'break-all' }}>{icalUrl}</code>
        </div>
      ) : (
        <p className="small muted" style={{ marginBottom: 18 }}>Подключается вместе с Supabase (раздел README «Подключение Supabase»).</p>
      )}

      <div className="chips" style={{ marginTop: 10 }}>
        <button className="btn btn-primary" onClick={save}>{saved ? 'Сохранено ✓' : 'Сохранить настройки'}</button>
      </div>
      <p className="small muted" style={{ marginTop: 14 }}>Slug {slug} меняется только администратором платформы.</p>
    </Section>
  )
}
