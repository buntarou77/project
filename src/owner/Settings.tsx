import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { Section, ConfirmDialog, AsyncButton } from '@/ui/common'
import { toast, toastError } from '@/ui/toast'
import { WEEKDAY_ORDER, WEEKDAY_RU, money, dtInTz } from '@/ui/format'
import { apiBaseUrl, env } from '@/lib/env'
import { icsFeedUrl } from '@/lib/ics'
import type { WeekSchedule } from '@/core/types'
import { DEFAULT_SECTION_ORDER, SECTION_LABELS, type ClosedPeriod, type SectionKey } from '@/core/types'
import { compressImage } from '@/lib/image'
import { PhotoPreviewModal } from '@/ui/PhotoPreview'
import { deepClone } from '@/lib/compat'

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

// Числовые поля держат строку во время редактирования: иначе удаление «0»
// мгновенно превращалось обратно в 0 и владелец не мог начать вводить число.
function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  id,
  placeholder,
}: {
  value: number
  onChange: (next: number) => void
  min?: number
  max?: number
  step?: number
  id?: string
  placeholder?: string
}) {
  const [text, setText] = useState(String(value))
  const lastEmitted = useRef(value)
  const parsed = /^-?\d+$/.test(text.trim()) ? Number(text.trim()) : null

  useEffect(() => {
    if (value !== lastEmitted.current) {
      setText(String(value))
      lastEmitted.current = value
    }
  }, [value])

  return (
    <input
      type="number"
      id={id}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(e) => {
        const next = e.target.value
        setText(next)
        const n = Number(next.trim())
        if (next.trim() && Number.isInteger(n)) {
          lastEmitted.current = n
          onChange(n)
        }
      }}
    />
  )
}

type CardSize = NonNullable<S['serviceCardSize']>

const CARD_SIZES: { v: CardSize; label: string; cols: number }[] = [
  { v: 'compact', label: 'Компактные', cols: 3 },
  { v: 'normal', label: 'Обычные', cols: 2 },
  { v: 'large', label: 'Крупные', cols: 1 },
]

function CardSizePicker({ value, onChange }: { value?: CardSize; onChange: (v: CardSize) => void }) {
  const current = value ?? 'normal'
  return (
    <div className="picker-row">
      {CARD_SIZES.map((t) => (
        <button
          key={t.v}
          type="button"
          className={`picker-item ${current === t.v ? 'active' : ''}`}
          onClick={() => onChange(t.v)}
        >
          <span className="service-size-mock" style={{ gridTemplateColumns: `repeat(${t.cols}, 1fr)` }}>
            {Array.from({ length: t.cols }).map((_, i) => <i key={i} />)}
          </span>
          <div className="small">{t.label}</div>
        </button>
      ))}
    </div>
  )
}

// Выбор оценки кликом по звёздам (с предпросмотром при наведении)
function StarPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hover, setHover] = useState(0)
  const shown = hover || value
  return (
    <div className="star-picker" role="radiogroup" aria-label="Оценка">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          className={`star ${n <= shown ? 'active' : ''}`}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={() => onChange(n)}
          aria-label={`${n} из 5`}
        >
          ★
        </button>
      ))}
    </div>
  )
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

// Свой график специалиста: undefined = как у студии. Дни/часы правятся здесь —
// availability учитывает окно при подборе (specialistWindowOk).
function SpecialistScheduleEditor({
  sp,
  draftSchedule,
  upd,
  bundle,
  slug,
}: {
  sp: Specialist
  draftSchedule: Specialist['schedule']
  upd: (id: string, patch: Partial<Specialist>) => void
  bundle: StudioBundle
  slug: string
}) {
  const qc = useQueryClient()
  const studio = bundle.settings.schedule
  // null = явно «как у студии», undefined = ещё не трогали (тоже как у студии)
  const cur: WeekSchedule | null = draftSchedule !== undefined ? draftSchedule : sp.schedule ?? null
  const own = cur !== null
  const sched: WeekSchedule = own ? (cur ?? studio) : studio

  // Z4: та же валидация, что у графика студии: совпадение open/close запрещено
  // (zod сервера его всё равно отклонит при «Сохранить» — лучше поймать раньше)
  const setDay = (day: keyof WeekSchedule, win: WeekSchedule[keyof WeekSchedule]) => {
    if (win && win.open === win.close) {
      toast('Открытие и закрытие не могут совпадать', 'err')
      return
    }
    if (win && win.close < win.open) {
      toast(`Ночная смена: ${win.open}–${win.close} (до следующего дня)`, 'warn')
    }
    upd(sp.id, { schedule: { ...sched, [day]: win } })
  }

  return (
    <details style={{ marginTop: 10 }}>
      <summary className="small" style={{ cursor: 'pointer' }}>
        График специалиста — {own ? 'свой' : 'как у студии'} (ночные смены допустимы)
      </summary>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {!own && (
          <AsyncButton className="btn btn-sm" busyLabel="Включаем…" onClick={async () => upd(sp.id, { schedule: { ...studio } })}>
            Задать свой график
          </AsyncButton>
        )}
        {own && (
          <>
            {WEEKDAY_ORDER.map((day) => {
              const win = sched[day]
              return (
                <div className="field" style={{ marginBottom: 0, minWidth: 210 }} key={day}>
                  <label>{WEEKDAY_RU[day]}</label>
                  {win ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input type="time" value={win.open} onChange={(e) => setDay(day, { open: e.target.value, close: win.close })} />
                      <span className="muted">—</span>
                      <input type="time" value={win.close} onChange={(e) => setDay(day, { open: win.open, close: e.target.value })} />
                      <button type="button" className="chip" onClick={() => setDay(day, null)}>Выходной</button>
                    </div>
                  ) : (
                    <button type="button" className="chip" onClick={() => setDay(day, { open: '10:00', close: '21:00' })}>
                      + Рабочий день
                    </button>
                  )}
                </div>
              )
            })}
            <div style={{ width: '100%', display: 'flex', gap: 8, marginTop: 8 }}>
              <AsyncButton
                className="btn btn-sm btn-primary"
                busyLabel="Сохраняем…"
                onClick={async () => {
                  await be.ownerUpsertSpecialist(slug, { ...sp, schedule: sched })
                  qc.invalidateQueries({ queryKey: ['studio', slug] })
                  toast('График сохранён')
                }}
              >
                Сохранить график
              </AsyncButton>
              <AsyncButton
                className="btn btn-sm"
                busyLabel="Сбрасываем…"
                onClick={async () => {
                  await be.ownerUpsertSpecialist(slug, { ...sp, schedule: null })
                  qc.invalidateQueries({ queryKey: ['studio', slug] })
                  toast('График как у студии')
                }}
              >
                Как у студии
              </AsyncButton>
            </div>
          </>
        )}
      </div>
    </details>
  )
}

function SpecialistsEditor({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, Partial<Specialist>>>({})
  const [delTarget, setDelTarget] = useState<Specialist | null>(null)
  // предпросмотр нового фото до загрузки: владелец видит кадрирование и
  // разрешение, и только по кнопке фото уходит на сервер
  const [preview, setPreview] = useState<{ file: File; sp: Specialist; input: HTMLInputElement } | null>(null)
  const upd = (id: string, patch: Partial<Specialist>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  // глобальное «Сохранить настройки» сбрасывает черновики карточек в базу
  useFlushOnSettingsSave(async () => {
    for (const [id, patch] of Object.entries(draft)) {
      const sp = bundle.specialists.find((x) => x.id === id)
      if (sp) await be.ownerUpsertSpecialist(slug, { ...sp, ...patch } as Specialist)
    }
  })
  async function save(sp: Specialist) {
    await be.ownerUpsertSpecialist(slug, { ...sp, ...(draft[sp.id] ?? {}) } as Specialist)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
    toast('Специалист сохранён')
  }
  // Фото необязательно: нет photoUrl — на витрине показываются инициалы.
  // Сразу сохраняем после загрузки, чтобы владельцу не пришлось жать «Сохранить».
  async function uploadPhoto(sp: Specialist, file: File) {
    if (!be.ownerUploadSpecialistPhoto) return
    const { src } = await be.ownerUploadSpecialistPhoto(slug, file)
    await be.ownerUpsertSpecialist(slug, { ...sp, ...(draft[sp.id] ?? {}), photoUrl: src } as Specialist)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
    toast('Фото загружено')
  }
  async function removePhoto(sp: Specialist) {
    await be.ownerUpsertSpecialist(slug, { ...sp, ...(draft[sp.id] ?? {}), photoUrl: undefined } as Specialist)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
    toast('Фото убрано')
  }
  async function del(sp: Specialist) {
    try {
      await be.ownerDeleteSpecialist!(slug, sp.id)
      qc.invalidateQueries({ queryKey: ['studio', slug] })
      toast('Специалист удалён')
    } catch (e) {
      toastError(e)
    }
  }
  return (
    <>
      {bundle.specialists.map((sp) => (
        <div className="card" key={sp.id} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="sp-photo" aria-hidden={!sp.photoUrl}>
              {sp.photoUrl ? <img src={sp.photoUrl} alt={sp.name} /> : <span className="avatar-fallback">{initialsOf(sp.name)}</span>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                {sp.photoUrl ? 'Заменить фото' : 'Загрузить фото'}
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) setPreview({ file: f, sp, input: e.currentTarget })
                    e.target.value = ''
                  }}
                />
              </label>
              {sp.photoUrl && (
                <button className="btn btn-sm" onClick={() => void removePhoto(sp)}>Убрать фото</button>
              )}
            </div>
            <div className="field" style={{ flex: 2, minWidth: 150, marginBottom: 0 }}>
              <label>Имя</label>
              <input defaultValue={sp.name} onChange={(e) => upd(sp.id, { name: e.target.value })} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 120, marginBottom: 0 }}>
              <label>Роль</label>
              <input defaultValue={sp.title} onChange={(e) => upd(sp.id, { title: e.target.value })} />
            </div>
            <div className="field" style={{ width: 90, marginBottom: 0 }}>
              <label>Съёмок/день</label>
              <input type="number" min={1} max={10} defaultValue={sp.dayLimit} onChange={(e) => upd(sp.id, { dayLimit: Number(e.target.value) })} />
            </div>
            <div className="field" style={{ width: 140, marginBottom: 0 }}>
              <label>Ставка, ₽/час</label>
              <input
                type="number"
                min={0}
                defaultValue={sp.hourRate ?? ''}
                placeholder="—"
                onChange={(e) => upd(sp.id, { hourRate: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
              <p className="small muted" style={{ margin: '4px 0 0' }}>Добавляется к почасовым услугам с этим специалистом</p>
            </div>
            <AsyncButton className="btn btn-sm btn-primary" onClick={() => save(sp)}>Сохранить</AsyncButton>
            <AsyncButton
              className="btn btn-sm"
              busyLabel="Меняем…"
              title="Показывать специалиста в блоке «Команда» на витрине"
              onClick={async () => {
                await be.ownerUpsertSpecialist(slug, { ...sp, showOnTeam: sp.showOnTeam === false })
                qc.invalidateQueries({ queryKey: ['studio', slug] })
                toast(sp.showOnTeam === false ? 'Возвращён в команду' : 'Скрыт из команды на витрине')
              }}
            >
              {sp.showOnTeam === false ? 'Скрыт из команды' : 'В команде'}
            </AsyncButton>
            <AsyncButton
              className="btn btn-sm"
              busyLabel="Меняем…"
              onClick={async () => {
                await be.ownerUpsertSpecialist(slug, { ...sp, active: !sp.active })
                qc.invalidateQueries({ queryKey: ['studio', slug] })
                toast(sp.active ? 'Специалист отключён' : 'Специалист включён')
              }}
            >
              {sp.active ? 'Отключить' : 'Включить'}
            </AsyncButton>
            {be.ownerDeleteSpecialist && (
              <button className="btn btn-sm" onClick={() => setDelTarget(sp)}>Удалить</button>
            )}
          </div>
          <SpecialistScheduleEditor
            sp={sp}
            draftSchedule={draft[sp.id]?.schedule}
            upd={upd}
            bundle={bundle}
            slug={slug}
          />
        </div>
      ))}
      <AsyncButton
        className="btn btn-sm"
        busyLabel="Добавляем…"
        onClick={() =>
          save({ id: `sp-${Date.now()}`, name: 'Новый специалист', title: '', active: true, dayLimit: 2 }).then(() =>
            toast('Специалист добавлен')
          )
        }
      >
        + Специалист
      </AsyncButton>

      <ConfirmDialog
        open={delTarget !== null}
        title="Удалить специалиста?"
        text={delTarget ? `«${delTarget.name}» исчезнет из кабинета и формы записи. Активные брони не пострадают — у них специалист просто отвяжется, его занятое время освободится.` : undefined}
        confirmLabel="Удалить"
        onConfirm={() => {
          if (delTarget) void del(delTarget)
          setDelTarget(null)
        }}
        onCancel={() => setDelTarget(null)}
      />

      {preview && (
        <PhotoPreviewModal
          files={[preview.file]}
          context="specialist"
          label={preview.sp.name}
          sub={preview.sp.title || 'Роль'}
          teamStyle={(bundle.settings.teamCardStyle ?? 'card') as 'card' | 'photo' | 'minimal'}
          onCancel={() => setPreview(null)}
          onPickAgain={() => preview.input.click()}
          onConfirm={() => {
            const p = preview
            setPreview(null)
            void compressImage(p.file).then(() => uploadPhoto(p.sp, p.file))
          }}
        />
      )}
    </>
  )
}

function HallsEditor({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, Partial<Hall>>>({})
  const [delTarget, setDelTarget] = useState<Hall | null>(null)
  const [preview, setPreview] = useState<{ files: File[]; hall: Hall; input: HTMLInputElement } | null>(null)
  const upd = (id: string, patch: Partial<Hall>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  useFlushOnSettingsSave(async () => {
    for (const [id, patch] of Object.entries(draft)) {
      const h = bundle.halls.find((x) => x.id === id)
      if (h) await be.ownerUpsertHall(slug, { ...h, ...patch } as Hall)
    }
  })
  async function save(h: Hall) {
    const merged = { ...h, ...(draft[h.id] ?? {}) } as Hall
    await be.ownerUpsertHall(slug, merged)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
    toast('Зал сохранён')
  }
  // Фото зала сохраняем сразу после изменения — как у специалистов
  async function persistPhotos(h: Hall, photos: string[]) {
    const merged = { ...h, ...(draft[h.id] ?? {}), photos } as Hall
    upd(h.id, { photos })
    await be.ownerUpsertHall(slug, merged)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
  }
  async function addPhotos(h: Hall, files: File[]) {
    if (!files.length || !be.ownerUploadHallPhoto) return
    try {
      const srcs: string[] = []
      for (const f of files.slice(0, 6)) {
        if (!f.type.startsWith('image/')) continue
        const { src } = await be.ownerUploadHallPhoto(slug, f)
        srcs.push(src)
      }
      const current = (draft[h.id]?.photos ?? h.photos ?? [])
      await persistPhotos(h, [...current, ...srcs])
      toast(srcs.length > 1 ? `Добавлено фото: ${srcs.length}` : 'Фото добавлено')
    } catch (e) {
      toastError(e)
    }
  }
  async function removePhoto(h: Hall, idx: number) {
    const current = draft[h.id]?.photos ?? h.photos ?? []
    try {
      await persistPhotos(h, current.filter((_, i) => i !== idx))
      toast('Фото удалено')
    } catch (e) {
      toastError(e)
    }
  }
  async function movePhoto(h: Hall, idx: number, dir: -1 | 1) {
    const current = [...(draft[h.id]?.photos ?? h.photos ?? [])]
    const j = idx + dir
    if (j < 0 || j >= current.length) return
    ;[current[idx], current[j]] = [current[j], current[idx]]
    try {
      await persistPhotos(h, current)
    } catch (e) {
      toastError(e)
    }
  }
  async function del(h: Hall) {
    try {
      await be.ownerDeleteHall!(slug, h.id)
      qc.invalidateQueries({ queryKey: ['studio', slug] })
      toast('Зал удалён')
    } catch (e) {
      toastError(e)
    }
  }
  return (
    <>
      {bundle.halls.map((h) => {
        const photos = draft[h.id]?.photos ?? h.photos ?? []
        return (
        <div className="card" key={h.id} style={{ marginBottom: 10 }}>
          <div className="hall-editor-photos">
            {photos.map((src, i) => (
              <span className="hall-photo-thumb" key={src + i}>
                <img src={src} alt={`${h.name} ${i + 1}`} />
                <button
                  type="button"
                  className="hall-photo-del"
                  title="Удалить фото"
                  onClick={() => void removePhoto(h, i)}
                >
                  ✕
                </button>
                {i > 0 && <button type="button" className="hall-photo-move" title="Раньше" onClick={() => void movePhoto(h, i, -1)}>←</button>}
                {i < photos.length - 1 && <button type="button" className="hall-photo-move right" title="Позже" onClick={() => void movePhoto(h, i, 1)}>→</button>}
              </span>
            ))}
            <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
              {photos.length ? '+ Ещё фото' : '+ Фото зала'}
              <input
                type="file"
                accept="image/*"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'))
                  if (files.length) setPreview({ files, hall: h, input: e.currentTarget })
                  e.target.value = ''
                }}
              />
            </label>
          </div>
          <p className="small muted" style={{ margin: '0 0 10px' }}>Фото показываются на витрине в карточке зала. Первое — главное.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 2, minWidth: 150, marginBottom: 0 }}>
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
            <AsyncButton className="btn btn-sm btn-primary" onClick={() => save(h)}>Сохранить</AsyncButton>
            <AsyncButton
              className="btn btn-sm"
              busyLabel="Меняем…"
              onClick={async () => {
                await be.ownerUpsertHall(slug, { ...h, active: !h.active })
                qc.invalidateQueries({ queryKey: ['studio', slug] })
                toast(h.active ? 'Зал отключён' : 'Зал включён')
              }}
            >
              {h.active ? 'Отключить' : 'Включить'}
            </AsyncButton>
            {be.ownerDeleteHall && (
              <button className="btn btn-sm" onClick={() => setDelTarget(h)}>Удалить</button>
            )}
          </div>
        </div>
        )
      })}
      <AsyncButton
        className="btn btn-sm"
        busyLabel="Добавляем…"
        onClick={() =>
          save({ id: `hall-${Date.now()}`, name: 'Новый зал', capacity: 6, rates: { weekday: { day: 1000, evening: 1300 }, weekend: { day: 1400, evening: 1600 } }, active: true }).then(() =>
            toast('Зал добавлен')
          )
        }
      >
        + Зал
      </AsyncButton>

      <ConfirmDialog
        open={delTarget !== null}
        title="Удалить зал?"
        text={delTarget ? `«${delTarget.name}» исчезнет с витрины и формы записи. Активные брони не пострадают — у них зал отвяжется, занятое им время освободится, услуги перестанут на него ссылаться.` : undefined}
        confirmLabel="Удалить"
        onConfirm={() => {
          if (delTarget) void del(delTarget)
          setDelTarget(null)
        }}
        onCancel={() => setDelTarget(null)}
      />

      {preview && (
        <PhotoPreviewModal
          files={preview.files}
          context="hall"
          label={preview.hall.name}
          sub={`до ${preview.hall.capacity} чел.`}
          onCancel={() => setPreview(null)}
          onPickAgain={() => preview.input.click()}
          onConfirm={() => {
            const p = preview
            setPreview(null)
            void addPhotos(p.hall, p.files)
          }}
        />
      )}
    </>
  )
}

// Допуслуги конкретной услуги: создаются/редактируются прямо в её карточке.
// Сущность хранится в таблице addons, привязка — services.addonIds.
// ✕ открепляет от услуги; если ни одна услуга больше не ссылается — сущность удаляется.
function ServiceAddonsEditor({ svc, bundle, slug }: { svc: Service; bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, Partial<Addon>>>({})
  const upd = (id: string, patch: Partial<Addon>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  useFlushOnSettingsSave(async () => {
    for (const [id, patch] of Object.entries(draft)) {
      const a = bundle.addons.find((x) => x.id === id)
      if (a) await be.ownerUpsertAddon(slug, { ...a, ...patch } as Addon)
    }
  })
  const attachedIds = svc.addonIds ?? []
  const attached = attachedIds
    .map((id) => bundle.addons.find((a) => a.id === id))
    .filter((a): a is Addon => Boolean(a))

  async function attach(newAddon?: Addon) {
    const addon =
      newAddon ??
      ({ id: `ad-${Date.now()}`, appliesTo: 'both', name: 'Новая допуслуга', price: 500, unit: 'booking' } as Addon)
    if (!newAddon) await be.ownerUpsertAddon(slug, addon)
    await be.ownerUpsertService(slug, { ...svc, addonIds: [...attachedIds, addon.id] })
    qc.invalidateQueries({ queryKey: ['studio', slug] })
    toast(newAddon ? 'Допуслуга добавлена' : 'Допуслуга создана и прикреплена')
  }

  async function saveAddon(a: Addon) {
    await be.ownerUpsertAddon(slug, { ...a, ...(draft[a.id] ?? {}) } as Addon)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
    toast('Допуслуга сохранена')
  }

  async function detach(a: Addon) {
    try {
      await be.ownerUpsertService(slug, { ...svc, addonIds: attachedIds.filter((x) => x !== a.id) })
      // сущность больше никому не нужна? (учитываем только явные списки)
      const usedElsewhere = bundle.services.some(
        (s) => s.id !== svc.id && (s.addonIds ?? []).includes(a.id)
      )
      if (!usedElsewhere) await be.ownerDeleteAddon(slug, a.id)
      qc.invalidateQueries({ queryKey: ['studio', slug] })
      toast('Допуслуга откреплена')
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <details className="card" style={{ marginTop: 12, padding: '10px 14px', background: 'var(--bg-soft)' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
        Допуслуги услуги ({attached.length})
      </summary>
      {attached.length === 0 && (
        <p className="small muted" style={{ margin: '10px 0' }}>
          Клиент не увидит дополнений к этой услуге, пока вы их не добавите.
        </p>
      )}
      {attached.map((a) => {
        const rawHallIds = draft[a.id]?.hallIds ?? a.hallIds
        const addonHallIds = rawHallIds?.length ? rawHallIds : null
        return (
        <div key={a.id} style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 2, minWidth: 140, marginBottom: 0 }}>
              <label>Название</label>
              <input defaultValue={a.name} onChange={(e) => upd(a.id, { name: e.target.value })} />
            </div>
            <div className="field" style={{ width: 110, marginBottom: 0 }}>
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
            <AsyncButton className="btn btn-sm btn-primary" onClick={() => saveAddon(a)}>Сохранить</AsyncButton>
            <button className="btn btn-sm" onClick={() => void detach(a)} title="Открепить от услуги">✕</button>
          </div>
          {bundle.halls.filter((h) => h.active).length > 0 && (
            <div style={{ margin: '8px 0 0' }}>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <label className="checkline" style={{ marginTop: 0 }}>
                  <input type="radio" checked={!addonHallIds} onChange={() => upd(a.id, { hallIds: undefined })} />
                  <span>Во всех залах</span>
                </label>
                <label className="checkline" style={{ marginTop: 0 }}>
                  <input
                    type="radio"
                    checked={Boolean(addonHallIds)}
                    onChange={() => upd(a.id, { hallIds: bundle.halls.filter((h) => h.active).map((h) => h.id) })}
                  />
                  <span>Только в выбранных</span>
                </label>
              </div>
              {addonHallIds && (
                <>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                    {bundle.halls.filter((h) => h.active).map((h) => (
                      <label className="checkline" key={h.id} style={{ marginTop: 0 }}>
                        <input
                          type="checkbox"
                          checked={addonHallIds.includes(h.id)}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...new Set([...addonHallIds, h.id])]
                              : addonHallIds.filter((x) => x !== h.id)
                            // пустой список = «во всех залах»: так владелец не
                            // останется с непонятным «нигде»
                            upd(a.id, { hallIds: next.length ? next : undefined })
                          }}
                        />
                        <span>{h.name}</span>
                      </label>
                    ))}
                  </div>
                  <p className="small muted" style={{ margin: '6px 0 0' }}>
                    Доп будет доступен только в отмеченных залах. Снимете все — снова «во всех».
                  </p>
                </>
              )}
            </div>
          )}
        </div>
        )
      })}
      <div style={{ marginTop: 12 }}>
        <AsyncButton className="btn btn-sm" busyLabel="Добавляем…" onClick={() => attach()}>
          + Допуслуга
        </AsyncButton>
      </div>
    </details>
  )
}

function ServicesEditor({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, Partial<Service>>>({})
  const [delTarget, setDelTarget] = useState<Service | null>(null)
  const [preview, setPreview] = useState<{ file: File; svc: Service; input: HTMLInputElement } | null>(null)
  const upd = (id: string, patch: Partial<Service>) => setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  // аренда всегда занимает зал: чиним старые записи при сохранении
  const normalizeService = (item: Service): Service =>
    item.kind === 'rental' ? { ...item, needsHall: true } : item
  useFlushOnSettingsSave(async () => {
    for (const [id, patch] of Object.entries(draft)) {
      const svc = bundle.services.find((x) => x.id === id)
      if (svc) await be.ownerUpsertService(slug, normalizeService({ ...svc, ...patch } as Service))
    }
  })
  async function save(svc: Service) {
    await be.ownerUpsertService(slug, normalizeService({ ...svc, ...(draft[svc.id] ?? {}) } as Service))
    qc.invalidateQueries({ queryKey: ['studio', slug] })
    toast('Услуга сохранена')
  }
  async function del(svc: Service) {
    try {
      await be.ownerDeleteService(slug, svc.id)
      qc.invalidateQueries({ queryKey: ['studio', slug] })
      toast('Услуга удалена')
    } catch (e) {
      toastError(e)
    }
  }
  // обложка услуги: сохраняем сразу после загрузки/удаления
  async function uploadPhoto(svc: Service, file: File) {
    if (!be.ownerUploadServicePhoto) return
    try {
      const { src } = await be.ownerUploadServicePhoto(slug, file)
      await be.ownerUpsertService(slug, { ...svc, ...(draft[svc.id] ?? {}), photoUrl: src } as Service)
      qc.invalidateQueries({ queryKey: ['studio', slug] })
      toast('Обложка услуги обновлена')
    } catch (e) {
      toastError(e)
    }
  }
  async function removePhoto(svc: Service) {
    try {
      await be.ownerUpsertService(slug, { ...svc, ...(draft[svc.id] ?? {}), photoUrl: undefined } as Service)
      qc.invalidateQueries({ queryKey: ['studio', slug] })
      toast('Обложка убрана')
    } catch (e) {
      toastError(e)
    }
  }
  const sorted = [...bundle.services].sort((a, b) => a.sort - b.sort)
  return (
    <>
      {sorted.map((svc) => {
        // live-состояние карточки: бандл + незасейвленный черновик.
        // Условные блоки (залы/специалисты) реагируют на галочки мгновенно.
        const cur = { ...svc, ...(draft[svc.id] ?? {}) } as Service
        // undefined/пусто в hallIds исторически означает «все залы»; для
        // явного выбора показываем отдельный режим, чтобы клик по залу не
        // снимал его из «всех» и не оставлял непонятный пустой список
        const activeHalls = bundle.halls.filter((h) => h.active)
        const hallIds = cur.hallIds?.length ? cur.hallIds : null
        const selectedActiveHalls = hallIds ? activeHalls.filter((h) => hallIds.includes(h.id)) : []
        const hallRequired = cur.kind === 'rental'
        const needHall = hallRequired || cur.needsHall
        const activeSpecialists = bundle.specialists.filter((sp) => sp.active)
        const allowedSpecialists = activeSpecialists.filter(
          (sp) => !cur.specialistIds?.length || cur.specialistIds.includes(sp.id)
        )
        const teamMode = Boolean(cur.needsSpecialist && cur.allSpecialistsRequired)
        const teamSpecialists = activeSpecialists.filter((sp) => cur.specialistIds?.includes(sp.id))
        const teamRates = teamSpecialists.map((sp) => sp.hourRate ?? 0).filter((r) => r > 0)
        const allowedHallRates = bundle.halls
          .filter((h) => h.active && (!cur.hallIds?.length || cur.hallIds.includes(h.id)))
          .map((h) => h.rates.weekday.day)
        const hourlyParts: string[] = []
        if (needHall) {
          hourlyParts.push(
            allowedHallRates.length
              ? `зал от ${money(Math.min(...allowedHallRates))}/час`
              : 'зал по тарифу'
          )
        }
        if (cur.needsSpecialist) {
          if (teamMode) {
            hourlyParts.push(
              teamRates.length
                ? `специалисты ${money(teamRates.reduce((a, b) => a + b, 0))}/час`
                : 'ставки специалистов'
            )
          } else {
            const rates = allowedSpecialists.map((sp) => sp.hourRate ?? 0).filter((r) => r > 0)
            hourlyParts.push(rates.length ? `специалист от ${money(Math.min(...rates))}/час` : 'ставка специалиста')
          }
        }
        const hourlyFormula = hourlyParts.length ? `${hourlyParts.join(' + ')} × часы` : ''
        // предупреждение о людях: лимит услуги против вместимости
        // разрешённых залов (белый список; пусто = все активные)
        const curMaxPeople = cur.maxPeople ?? 0
        const allowedCapacities = bundle.halls
          .filter((h) => h.active && (!cur.hallIds?.length || cur.hallIds.includes(h.id)))
          .map((h) => h.capacity)
        const maxHallCapacity = allowedCapacities.length ? Math.max(...allowedCapacities) : 0
        const peopleOverflow = needHall && curMaxPeople > 0 && curMaxPeople > maxHallCapacity
        return (
        <details className="card" key={svc.id} style={{ marginBottom: 10 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
            {cur.name} · {cur.priceType === 'fixed' ? money(cur.price) : 'почасово'} · {cur.kind === 'shoot' ? 'съёмка' : 'аренда'}
          </summary>
          <div className="grid grid-2" style={{ marginTop: 12 }}>
            <div className="field">
              <label>Обложка услуги</label>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {svc.photoUrl ? (
                  <img src={svc.photoUrl} alt={svc.name} style={{ width: 96, height: 64, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--line)' }} />
                ) : (
                  <span className="muted small">без фото</span>
                )}
                <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
                  {svc.photoUrl ? 'Заменить' : 'Загрузить'}
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) setPreview({ file: f, svc, input: e.currentTarget })
                      e.target.value = ''
                    }}
                  />
                </label>
                {svc.photoUrl && <button className="btn btn-sm" onClick={() => void removePhoto(svc)}>Убрать</button>}
              </div>
            </div>
            <Row label="Название"><input defaultValue={svc.name} onChange={(e) => upd(svc.id, { name: e.target.value })} /></Row>
            <Row label="Вид и цена">
              <select
                value={cur.priceType}
                onChange={(e) => upd(svc.id, { priceType: e.target.value as Service['priceType'] })}
              >
                <option value="fixed">Фиксированная цена (пакет)</option>
                <option value="hourly">Почасово — ресурсы × часы</option>
              </select>
              {cur.priceType === 'hourly' ? (
                <p className="small muted" style={{ margin: '6px 0 0' }}>
                  Поле «Цена» игнорируется. {hourlyFormula || 'Включите зал или специалиста — иначе считать нечего'}.
                  Тарифы залов — в разделе «Залы и тарифы», ставки специалистов — ниже в этой карточке.
                </p>
              ) : (
                <input
                  type="number"
                  min={0}
                  defaultValue={cur.price}
                  placeholder="5000"
                  style={{ marginTop: 6 }}
                  onChange={(e) => upd(svc.id, { price: Number(e.target.value) })}
                />
              )}
            </Row>
            <Row label="Тип записи">
              <select
                value={cur.kind}
                onChange={(e) => {
                  const kind = e.target.value as Service['kind']
                  upd(svc.id, { kind, ...(kind === 'rental' ? { needsHall: true } : {}) })
                }}
              >
                <option value="shoot">Съёмка</option>
                <option value="rental">Аренда зала (зал обязателен)</option>
              </select>
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                Оба типа показываются в блоке «Услуги и аренда». Карточки залов идут
                отдельным блоком ниже. Зал и специалист включаются галочками ниже.
              </p>
            </Row>
            <Row label="Описание"><input defaultValue={svc.description} onChange={(e) => upd(svc.id, { description: e.target.value })} /></Row>
            <Row label="Длительность, мин">
              <input type="number" min={30} step={30} defaultValue={svc.durationMin} onChange={(e) => upd(svc.id, { durationMin: Number(e.target.value) })} />
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                Базовая длина брони. Клиент сможет брать кратно (до 8 ч): 60 мин → 1 ч…8 ч, 120 мин → 2 ч…8 ч.
              </p>
            </Row>
            <Row label="Максимум человек">
              <input
                type="number"
                min={1}
                defaultValue={cur.maxPeople ?? ''}
                placeholder="без ограничения"
                onChange={(e) => upd(svc.id, { maxPeople: e.target.value ? Number(e.target.value) : undefined })}
              />
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                Жёсткий лимит людей на эту услугу, независимо от вместимости зала.
              </p>
              {peopleOverflow && (
                <p className="small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                  Ни один разрешённый зал не вмещает {curMaxPeople} человек — слотов с таким числом людей не будет
                </p>
              )}
            </Row>
            <Row label="Что входит (по строке)"><textarea defaultValue={svc.includes.join('\n')} onChange={(e) => upd(svc.id, { includes: e.target.value.split('\n').filter(Boolean) })} /></Row>
            <Row label="Результат (что сдаёте)"><input defaultValue={svc.deliverableText} onChange={(e) => upd(svc.id, { deliverableText: e.target.value })} /></Row>
            <Row label="Срок сдачи, дней"><input type="number" min={0} defaultValue={svc.deadlineDays} onChange={(e) => upd(svc.id, { deadlineDays: Number(e.target.value) })} /></Row>
            <Row label="Предоплата">
              <div style={{ display: 'flex', gap: 8 }}>
                <select defaultValue={svc.prepayment.type} onChange={(e) => upd(svc.id, { prepayment: { ...svc.prepayment, type: e.target.value as 'percent' | 'amount' } })}>
                  <option value="percent">Процент (%)</option>
                  <option value="amount">Сумма (₽)</option>
                </select>
                <input type="number" min={0} max={svc.prepayment.type === 'percent' ? 100 : undefined} defaultValue={svc.prepayment.value} onChange={(e) => upd(svc.id, { prepayment: { ...svc.prepayment, value: Number(e.target.value) } })} />
              </div>
              {cur.prepayment.type === 'percent' && cur.prepayment.value > 100 && (
                <p className="small" style={{ margin: '6px 0 0', color: 'var(--bad)' }} role="alert">
                  Процент предоплаты не может быть больше 100. Если вы имели в виду рубли — выберите «Сумма (₽)».
                </p>
              )}
            </Row>
            <Row label="Подготовка/уборка, мин">
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" min={0} defaultValue={svc.setupMin} onChange={(e) => upd(svc.id, { setupMin: Number(e.target.value) })} />
                <input type="number" min={0} defaultValue={svc.cleanupMin} onChange={(e) => upd(svc.id, { cleanupMin: Number(e.target.value) })} />
              </div>
            </Row>
            <Row label="Ресурсы и режимы">
              {/* белый список специалистов НЕ стираем при снятии галки:
                  при повторном включении он должен сохраниться */}
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={cur.needsSpecialist}
                  onChange={(e) => upd(svc.id, { needsSpecialist: e.target.checked })}
                />
                <span>нужен специалист</span>
              </label>
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={cur.referencesEnabled ?? cur.needsSpecialist}
                  onChange={(e) => upd(svc.id, { referencesEnabled: e.target.checked })}
                />
                <span>просить референсы</span>
              </label>
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                Авто: для услуг со специалистом — включено, для чистой аренды зала — нет.
                Галочка фиксирует решение явно.
              </p>
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={needHall}
                  disabled={hallRequired}
                  onChange={(e) => upd(svc.id, { needsHall: e.target.checked })}
                />
                <span>нужен зал{hallRequired ? ' (аренда — всегда)' : ''}</span>
              </label>
              {!cur.needsSpecialist && !needHall && (
                <p className="small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                  Без зала и специалиста услугу оказать нельзя — включите хотя бы один ресурс.
                </p>
              )}
              {/* Z4: контролируемые — defaultChecked после save+refetch мог показывать протухшее */}
              <label className="checkline"><input type="checkbox" checked={cur.fullDay} onChange={(e) => upd(svc.id, { fullDay: e.target.checked })} /><span>весь день</span></label>
              <label className="checkline"><input type="checkbox" checked={cur.autoConfirm} onChange={(e) => upd(svc.id, { autoConfirm: e.target.checked })} /><span>автоподтверждение</span></label>
            </Row>
            {cur.needsSpecialist && bundle.specialists.length > 0 && (
              <Row label="Специалисты услуги">
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {activeSpecialists.map((sp) => {
                    const specialistIds = cur.specialistIds
                    const checked = specialistIds ? specialistIds.includes(sp.id) : true
                    return (
                      <label className="checkline" key={sp.id} style={{ marginTop: 0 }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const base = specialistIds ?? activeSpecialists.map((x) => x.id)
                            const next = e.target.checked
                              ? [...new Set([...base, sp.id])]
                              : base.filter((x) => x !== sp.id)
                            upd(svc.id, { specialistIds: next })
                          }}
                        />
                        <span>
                          {sp.name}
                          {sp.hourRate ? ` · ${money(sp.hourRate)}/час` : ' · ставка не задана'}
                        </span>
                      </label>
                    )
                  })}
                </div>
                <label className="checkline" style={{ marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={teamMode}
                    onChange={(e) => {
                      const ids = cur.specialistIds?.length
                        ? cur.specialistIds
                        : activeSpecialists.map((sp) => sp.id)
                      upd(svc.id, { allSpecialistsRequired: e.target.checked, specialistIds: ids })
                    }}
                  />
                  <span>услугу выполняют все отмеченные специалисты</span>
                </label>
                <p className="small muted" style={{ margin: '6px 0 0' }}>
                  {teamMode
                    ? 'Клиент не выбирает специалиста: в бронь входят все отмеченные, их ставки суммируются в почасовой цене.'
                    : 'Кто может брать эту услугу. Клиент выберет одного из отмеченных (или любого активного, если список пуст).'}
                </p>
                {teamMode && !cur.specialistIds?.length && (
                  <p className="small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                    Для режима команды отметьте хотя бы одного специалиста — иначе запись будет недоступна.
                  </p>
                )}
                {!teamMode && !cur.specialistIds?.length && (
                  <p className="small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                    Отметьте хотя бы одного специалиста, если хотите ограничить круг — иначе услугу может взять любой активный.
                  </p>
                )}
              </Row>
            )}
            {needHall && bundle.halls.length > 0 && (
              <Row label="Доступные залы">
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <label className="checkline" style={{ marginTop: 0 }}>
                    <input
                      type="radio"
                      checked={!hallIds}
                      onChange={() => upd(svc.id, { hallIds: undefined })}
                    />
                    <span>Все залы</span>
                  </label>
                  <label className="checkline" style={{ marginTop: 0 }}>
                    <input
                      type="radio"
                      checked={Boolean(hallIds)}
                      onChange={() => {
                        if (hallIds || activeHalls.length === 0) return
                        upd(svc.id, { hallIds: [activeHalls[0].id] })
                      }}
                    />
                    <span>Только в выбранных</span>
                  </label>
                </div>
                {hallIds ? (
                  <>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                      {activeHalls.map((h) => {
                        const checked = Boolean(hallIds.includes(h.id))
                        // пустой список нельзя сохранять: в текущей модели он
                        // означает «все залы», поэтому последний не снимаем
                        const lastChecked = checked && selectedActiveHalls.length === 1
                        return (
                          <label className="checkline" key={h.id} style={{ marginTop: 0 }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={lastChecked}
                              title={lastChecked ? 'Должен остаться хотя бы один зал' : undefined}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...new Set([...hallIds, h.id])]
                                  : hallIds.filter((x) => x !== h.id)
                                if (next.length) upd(svc.id, { hallIds: next })
                              }}
                            />
                            <span>{h.name}</span>
                          </label>
                        )
                      })}
                    </div>
                    <p className="small muted" style={{ margin: '6px 0 0' }}>
                      Услуга будет доступна только в отмеченных залах. Последний зал снять нельзя —
                      для «везде» выберите «Все залы».
                    </p>
                    {selectedActiveHalls.length === 0 && (
                      <p className="small" style={{ margin: '6px 0 0', color: 'var(--warn)' }}>
                        Нет ни одного активного зала в списке — отметьте хотя бы один.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="small muted" style={{ margin: '6px 0 0' }}>
                    Услуга доступна во всех активных залах.
                  </p>
                )}
              </Row>
            )}
            <Row label="Макс. дней (многодневная)"><input type="number" min={1} max={5} defaultValue={svc.multiDayMax} onChange={(e) => upd(svc.id, { multiDayMax: Number(e.target.value) })} /></Row>
            <Row label="Порядок"><input type="number" defaultValue={svc.sort} onChange={(e) => upd(svc.id, { sort: Number(e.target.value) })} /></Row>
          </div>
          <ServiceAddonsEditor svc={cur} bundle={bundle} slug={slug} />
          <div className="chips">
            <AsyncButton className="btn btn-sm btn-primary" onClick={() => save(svc)}>Сохранить услугу</AsyncButton>
            <button className="btn btn-sm" onClick={() => setDelTarget(svc)}>Удалить</button>
          </div>
        </details>
        )
      })}
      <AsyncButton
        className="btn btn-sm"
        busyLabel="Добавляем…"
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
      </AsyncButton>

      <ConfirmDialog
        open={delTarget !== null}
        title="Удалить услугу?"
        text={delTarget ? `«${delTarget.name}» исчезнет с витрины и формы записи. Активные брони не пострадают.` : undefined}
        onConfirm={() => {
          if (delTarget) void del(delTarget)
          setDelTarget(null)
        }}
        onCancel={() => setDelTarget(null)}
      />

      {preview && (
        <PhotoPreviewModal
          files={[preview.file]}
          context="service"
          label={preview.svc.name}
          sub={preview.svc.priceType === 'fixed' ? money(preview.svc.price) : 'по тарифу зала'}
          onCancel={() => setPreview(null)}
          onPickAgain={() => preview.input.click()}
          onConfirm={() => {
            const p = preview
            setPreview(null)
            void compressImage(p.file).then(() => uploadPhoto(p.svc, p.file))
          }}
        />
      )}
    </>
  )
}


// ---------- оформление страницы настроек ----------

// Нижняя кнопка «Сохранить настройки» сохраняет и незасейвленные черновики
// карточек каталога (специалисты/залы/услуги/допы): редакторы регистрируют
// здесь свой flush, который OwnerSettings вызывает перед сохранением настроек.
const FlushRegistryCtx = createContext<{ register: (fn: () => Promise<void>) => () => void } | null>(null)

function useFlushOnSettingsSave(flush: () => Promise<void>) {
  const ctx = useContext(FlushRegistryCtx)
  const ref = useRef(flush)
  ref.current = flush
  useEffect(() => {
    if (!ctx) return
    return ctx.register(() => ref.current())
  }, [ctx])
}

function Block({ id, title, desc, children }: { id: string; title: string; desc?: string; children: ReactNode }) {
  return (
    <section id={id} className="settings-block">
      <h3>{title}</h3>
      {desc && <p className="settings-desc">{desc}</p>}
      {children}
    </section>
  )
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="switch-row">
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="knob" />
      </span>
      <span>
        <b>{label}</b>
        {hint && <div className="small muted">{hint}</div>}
      </span>
    </label>
  )
}

// Мини-аватар для превью вида карточек: реальное фото из портфолио или инициалы
function MiniAvatar({ bundle, rect }: { bundle: StudioBundle; rect?: boolean }) {
  const sample = bundle.portfolio.find((p) => p.kind === 'image' && p.src)?.src
  const style: React.CSSProperties = rect
    ? { width: 54, height: 68, borderRadius: 8, margin: 0 }
    : { width: 38, height: 38, margin: 0 }
  return (
    <span className={`sp-photo ${rect ? 'rect' : ''}`} style={style}>
      {sample ? <img src={sample} alt="" /> : <span className="avatar-fallback" style={{ fontSize: 11 }}>АВ</span>}
    </span>
  )
}

const SETTINGS_NAV: [string, string][] = [
  ['set-common', 'Общее'],
  ['set-look', 'Внешний вид'],
  ['set-sections', 'Порядок блоков'],
  ['set-team', 'Команда'],
  ['set-rules', 'Режимы и отмена'],
  ['set-travel', 'Выезды'],
  ['set-schedule', 'График'],
  ['set-closed', 'Закрытые даты'],
  ['set-vacations', 'Отпуска'],
  ['set-cards', 'Карточки'],
  ['set-reviews', 'Отзывы'],
  ['set-people', 'Специалисты'],
  ['set-halls', 'Залы'],
  ['set-services', 'Услуги'],
  ['set-ical', 'iCal'],
]

// Зоны выезда живут в settings студии: фиксированный сбор уходит в цену,
// а время дороги до/после — в занятость специалиста.
function TravelZonesEditor({ zones, onChange }: { zones: S['travelZones']; onChange: (next: S['travelZones']) => void }) {
  const update = (index: number, patch: Partial<S['travelZones'][number]>) => {
    onChange(zones.map((zone, i) => (i === index ? { ...zone, ...patch } : zone)))
  }
  const duplicateIds = new Set(zones.map((z) => z.id)).size !== zones.length
  const invalid = zones.some(
    (z) => !z.name.trim() || z.extraFee < 0 || z.minutesBefore < 0 || z.minutesAfter < 0
  )

  return (
    <>
      {zones.map((zone, i) => (
        <div className="card" key={zone.id} style={{ marginBottom: 10 }}>
          <div className="grid grid-2">
            <Row label="Название зоны">
              <input
                type="text"
                value={zone.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="выезд по городу"
              />
            </Row>
            <Row label="Фиксированный сбор, ₽">
              <NumberInput
                value={zone.extraFee}
                onChange={(next) => update(i, { extraFee: next })}
                min={0}
                step={1}
              />
            </Row>
            <Row label="Дорога до съёмки, мин">
              <NumberInput
                value={zone.minutesBefore}
                onChange={(next) => update(i, { minutesBefore: next })}
                min={0}
                step={1}
              />
            </Row>
            <Row label="Дорога после съёмки, мин">
              <NumberInput
                value={zone.minutesAfter}
                onChange={(next) => update(i, { minutesAfter: next })}
                min={0}
                step={1}
              />
            </Row>
          </div>
          <div className="chips" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              onClick={() => onChange(zones.filter((_, j) => j !== i))}
            >
              Удалить
            </button>
          </div>
        </div>
      ))}

      {(duplicateIds || invalid) && (
        <p className="small" style={{ color: 'var(--bad)' }} role="alert">
          {duplicateIds ? 'Идентификаторы зон дублируются — исправьте конфигурацию.' : 'Заполните название зон; сборы и время дороги не могут быть отрицательными.'}
        </p>
      )}

      <div className="chips">
        <button
          type="button"
          className="btn btn-sm"
          disabled={zones.length >= 10}
          onClick={() =>
            onChange([
              ...zones,
              {
                id: `zone-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
                name: 'Новая зона',
                minutesBefore: 0,
                minutesAfter: 0,
                extraFee: 0,
              },
            ])
          }
        >
          + Зона выезда
        </button>
        {zones.length === 0 && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              onChange([
                { id: 'city', name: 'Выезд по городу', minutesBefore: 0, minutesAfter: 0, extraFee: 0 },
                { id: 'suburb', name: 'Выезд за город', minutesBefore: 60, minutesAfter: 60, extraFee: 1000 },
              ])
            }
          >
            + Типовые зоны выезда
          </button>
        )}
      </div>

      <p className="small muted" style={{ margin: '8px 0 0' }}>
        Сбор добавляется к цене один раз, время дороги блокирует специалиста до и после съёмки.
        Чтобы клиент мог выбрать выезд, нужна хотя бы одна услуга без зала и минимум две зоны.
      </p>
    </>
  )
}

// Отпуска специалистов / закрытия залов и студии: пишутся в closed_periods,
// ядро availability уже умеет их вычитать (loadBusy)
// активные заявки, пересекающие закрытый период (боевой сервер возвращает
// в ответе POST; демо-адаптер — нет)
type ClosedPeriodConflict = { id: string; serviceName: string; clientName: string; startsAtMs: number }

function ClosedPeriodsEditor({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const [conflicts, setConflicts] = useState<ClosedPeriodConflict[]>([])
  const [form, setForm] = useState<{ resourceType: ClosedPeriod['resourceType']; resourceId: string; dateFrom: string; dateTo: string; reason: string }>({
    resourceType: 'studio',
    resourceId: '',
    dateFrom: '',
    dateTo: '',
    reason: '',
  })
  const { data: items = [] } = useQuery({
    queryKey: ['closed-periods', slug],
    queryFn: () => be.ownerClosedPeriods!(slug),
    enabled: Boolean(be.ownerClosedPeriods),
  })

  const nameOf = (cp: ClosedPeriod) => {
    if (cp.resourceType === 'specialist') return bundle.specialists.find((x) => x.id === cp.resourceId)?.name ?? 'специалист'
    if (cp.resourceType === 'hall') return bundle.halls.find((x) => x.id === cp.resourceId)?.name ?? 'зал'
    return 'вся студия'
  }

  async function add() {
    if (!form.dateFrom || !form.dateTo) {
      toast('Укажите обе даты', 'err')
      return
    }
    if (form.dateTo < form.dateFrom) {
      toast('Дата «по» не может быть раньше даты «с»', 'err')
      return
    }
    setConflicts([])
    try {
      // по интерфейсу адаптер возвращает void; боевой Express кладёт в ответ
      // conflicts — читаем без гарантий, демо их просто не отдаёт
      const res = (await be.ownerUpsertClosedPeriod!(slug, {
        id: `cp-${Date.now()}`,
        resourceType: form.resourceType,
        resourceId: form.resourceType === 'studio' ? null : form.resourceId || null,
        dateFrom: form.dateFrom,
        dateTo: form.dateTo,
        reason: form.reason,
      })) as unknown as { conflicts?: ClosedPeriodConflict[] }
      if (Array.isArray(res?.conflicts)) setConflicts(res.conflicts)
      setForm({ ...form, dateFrom: '', dateTo: '', reason: '' })
      qc.invalidateQueries({ queryKey: ['closed-periods', slug] })
      toast('Период закрыт — слоты заняты')
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <>
      {items.length === 0 && <p className="small muted">Пока пусто — отпуск фотографа или ремонт зала закрывают слоты автоматически.</p>}
      {items.map((cp) => (
        <div className="card booking-row" key={cp.id} style={{ marginBottom: 8 }}>
          <div>
            <strong>{nameOf(cp)}</strong>
            <div className="small muted">
              {cp.dateFrom} — {cp.dateTo}{cp.reason ? ` · ${cp.reason}` : ''}
            </div>
          </div>
          <AsyncButton
            className="chip"
            busyLabel="Открываем…"
            onClick={async () => {
              try {
                await be.ownerDeleteClosedPeriod!(slug, cp.id)
                qc.invalidateQueries({ queryKey: ['closed-periods', slug] })
                toast('Период открыт')
              } catch (e) {
                toastError(e)
              }
            }}
          >
            Открыть
          </AsyncButton>
        </div>
      ))}
      <div className="card" style={{ marginBottom: 0 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Что закрываем</label>
            <select value={form.resourceType} onChange={(e) => setForm({ ...form, resourceType: e.target.value as ClosedPeriod['resourceType'], resourceId: '' })}>
              <option value="studio">Вся студия</option>
              {bundle.specialists.length > 0 && <option value="specialist">Специалист (отпуск)</option>}
              {bundle.halls.length > 0 && <option value="hall">Зал</option>}
            </select>
          </div>
          {form.resourceType !== 'studio' && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Кто/что</label>
              <select value={form.resourceId} onChange={(e) => setForm({ ...form, resourceId: e.target.value })}>
                <option value="">— выберите —</option>
                {(form.resourceType === 'specialist' ? bundle.specialists : bundle.halls).map((x) => (
                  <option key={x.id} value={x.id}>{x.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="field" style={{ marginBottom: 0 }}>
            <label>С</label>
            <input type="date" value={form.dateFrom} onChange={(e) => setForm({ ...form, dateFrom: e.target.value })} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>По</label>
            <input type="date" value={form.dateTo} onChange={(e) => setForm({ ...form, dateTo: e.target.value })} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 140, marginBottom: 0 }}>
            <label>Причина (необязательно)</label>
            <input type="text" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </div>
          <AsyncButton className="btn btn-sm btn-primary" busyLabel="Закрываем…" onClick={add}>
            Закрыть
          </AsyncButton>
        </div>
        {conflicts.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <p className="small" style={{ margin: '0 0 4px' }}>
              Период сохранён. Пересекается с активными заявками — решите их вручную:
            </p>
            <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
              {conflicts.map((c) => (
                <li key={c.id}>
                  {c.clientName} — {c.serviceName}, {dtInTz(bundle.settings.tz, c.startsAtMs)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  )
}

// Порядок блоков витрины с плавной перестановкой (FLIP): перед ререндером
// запоминаем позиции строк, после — мгновенно сдвигаем transform'ом на старое
// место и отпускаем в ноль с транзишеном. Библиотеки не нужны.
function SectionsOrderEditor({ order, onChange }: { order: SectionKey[]; onChange: (next: SectionKey[]) => void }) {
  const refs = useRef<Map<string, HTMLDivElement>>(new Map())
  const firstTops = useRef<Map<string, number> | null>(null)

  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= order.length) return
    const first = new Map<string, number>()
    refs.current.forEach((el, key) => first.set(key, el.getBoundingClientRect().top))
    firstTops.current = first
    const next = [...order]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  useLayoutEffect(() => {
    const first = firstTops.current
    if (!first) return
    firstTops.current = null
    refs.current.forEach((el, key) => {
      const prevTop = first.get(key)
      if (prevTop === undefined) return
      const delta = prevTop - el.getBoundingClientRect().top
      if (Math.abs(delta) < 1) return
      el.style.transition = 'none'
      el.style.transform = `translateY(${delta}px)`
      requestAnimationFrame(() => {
        el.style.transition = 'transform 0.28s ease'
        el.style.transform = ''
      })
    })
  }, [order])

  return (
    <>
      {order.map((key, i) => (
        <div
          key={key}
          className="order-row"
          ref={(el) => {
            if (el) refs.current.set(key, el)
            else refs.current.delete(key)
          }}
        >
          <span className="order-num">{i + 1}</span>
          <span className="order-label">{SECTION_LABELS[key]}</span>
          <span className="chips">
            <button type="button" className="chip" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`${SECTION_LABELS[key]} выше`}>↑</button>
            <button type="button" className="chip" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={`${SECTION_LABELS[key]} ниже`}>↓</button>
          </span>
        </div>
      ))}
    </>
  )
}

const HERO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

// Своё фото фона шапки — не из портфолио. Приоритетнее выбора работы в селекте
// «Фоновое фото (hero)». Загрузка и удаление сохраняются сразу (как фото
// специалистов и залов): файл уже ушёл на сервер, сиротой оставлять нельзя.
function HeroPhotoField({
  slug,
  value,
  studio,
  onChange,
}: {
  slug: string
  value?: string
  studio: { name: string; tagline: string; city: string }
  // пишет url в настройки и сохраняет их целиком — как «Сохранить настройки»
  onChange: (url: string | undefined) => Promise<void>
}) {
  const [preview, setPreview] = useState<{ file: File; input: HTMLInputElement } | null>(null)
  const [busy, setBusy] = useState(false)

  async function upload(file: File) {
    if (!be.ownerUploadHeroPhoto) return
    if (!HERO_MIME.has(file.type)) {
      toast('Допустимы только jpg, png и webp', 'err')
      return
    }
    setBusy(true)
    try {
      // сжатие — внутри адаптера (там же падает на недекодируемом файле)
      const { src } = await be.ownerUploadHeroPhoto(slug, file)
      await onChange(src)
      toast('Своё фото фона загружено')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await onChange(undefined)
      toast('Своё фото убрано — фон снова из портфолио')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {value ? (
          <img
            src={value}
            alt="Своё фото фона"
            style={{ width: 208, aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 10, border: '1px solid var(--line)' }}
          />
        ) : (
          <span className="small muted">не задано</span>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
          <label className="btn btn-sm" style={{ cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Сохраняем…' : value ? 'Заменить фото' : 'Загрузить своё фото'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f && !busy) setPreview({ file: f, input: e.currentTarget })
                e.target.value = ''
              }}
            />
          </label>
          {value && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void remove()}>
              Убрать своё фото
            </button>
          )}
        </div>
      </div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        JPG, PNG или WebP — сожмём на устройстве. Для чёткого фона — от 1600 px по ширине, горизонтальный кадр.
      </p>

      {preview && (
        <PhotoPreviewModal
          files={[preview.file]}
          context="hero"
          studio={studio}
          onCancel={() => setPreview(null)}
          onPickAgain={() => preview.input.click()}
          onConfirm={() => {
            const p = preview
            setPreview(null)
            void upload(p.file)
          }}
        />
      )}
    </div>
  )
}

export default function OwnerSettings({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const [s, setS] = useState<S>(deepClone(bundle.settings))
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
    const [open, close] = value === null ? ['', ''] : value.split('-')
    // Y1: ночь разрешена (close < open = смена до следующего дня); запрещены
    // только совпадение и смена длиннее 24 ч
    if (value !== null && open === close) {
      toast('Открытие и закрытие не могут совпадать', 'err')
      return
    }
    if (value !== null && close < open) {
      // ночная смена — легитимна, но предупредим, чтобы случайное «перевернули
      // время» не прошло молча
      // Z4: warn, а не ok — зелёная плашка читалась как подтверждение успеха
      toast(`Ночная смена: ${open}–${close} (до следующего дня)`, 'warn')
    }
    setS((prev) => ({
      ...prev,
      schedule: { ...prev.schedule, [key]: value === null ? null : { open, close } },
    }))
    setSaved(false)
  }

  // своё фото hero сохраняем сразу — файл уже на сервере; уходит весь текущий
  // черновик настроек, чтобы выбор в селекте «Фоновое фото» не разошёлся с фоном
  const persistHero = async (url: string | undefined) => {
    await be.ownerSaveSettings(slug, { ...s, heroPhotoUrl: url })
    set({ heroPhotoUrl: url })
    qc.invalidateQueries({ queryKey: ['studio', slug] })
  }

  async function save() {
    // сначала незасейвленные черновики карточек, потом сами настройки;
    // ошибка валидации каталога прерывает сохранение с тостом
    try {
      await Promise.all([...flushers.current].map((f) => f()))
    } catch (e) {
      toastError(e)
      return
    }
    await be.ownerSaveSettings(slug, s)
    setSaved(true)
    // ['owner-studios'] — чтобы новое имя студии сразу появилось в селекторе кабинета
    qc.invalidateQueries({ queryKey: ['studio', slug] })
    qc.invalidateQueries({ queryKey: ['owner-studios'] })
    toast('Настройки сохранены')
  }

  const flushers = useRef<Set<() => Promise<void>>>(new Set())
  const flushCtx = useMemo(
    () => ({
      register: (fn: () => Promise<void>) => {
        flushers.current.add(fn)
        return () => {
          flushers.current.delete(fn)
        }
      },
    }),
    []
  )

  const icalUrl = !icalToken
    ? null
    : be.kind === 'express'
      ? icsFeedUrl(apiBaseUrl, slug, icalToken)
      : env.VITE_SUPABASE_URL
        ? `${env.VITE_SUPABASE_URL}/functions/v1/ics?slug=${slug}&token=${icalToken}`
        : null

  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <FlushRegistryCtx.Provider value={flushCtx}>
    <Section>
      <h2>Настройки студии</h2>

      {/* якорная навигация: один клик — и вы у нужного блока */}
      <nav className="settings-nav glass" aria-label="Разделы настроек">
        {SETTINGS_NAV.map(([id, label]) => (
          <button key={id} type="button" className="chip" onClick={() => jumpTo(id)}>{label}</button>
        ))}
      </nav>

      <Block id="set-common" title="Общая информация" desc="Как студия выглядит на витрине и в поиске.">
        <div className="grid grid-2">
          <div>
            <Row label="Название"><input type="text" value={s.name} onChange={(e) => set({ name: e.target.value })} /></Row>
            <Row label="Слоган"><input type="text" value={s.tagline} onChange={(e) => set({ tagline: e.target.value })} /></Row>
            <Row label="Описание"><textarea value={s.description} onChange={(e) => set({ description: e.target.value })} /></Row>
          </div>
          <div>
            <Row label="Город"><input type="text" value={s.city} onChange={(e) => set({ city: e.target.value })} /></Row>
            <Row label="Адрес"><input type="text" value={s.address} onChange={(e) => set({ address: e.target.value })} /></Row>
            <Row label="Ссылка на Яндекс Карты"><input type="url" value={s.mapsUrl} onChange={(e) => set({ mapsUrl: e.target.value })} /></Row>
            <Row label="Телефон"><input type="tel" value={s.phone} onChange={(e) => set({ phone: e.target.value })} /></Row>
          </div>
        </div>
      </Block>

      <Block id="set-look" title="Внешний вид" desc="Цвет и тема витрины — превью справа, менять ничего не нужно.">
        <Row label="Акцентный цвет">
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="color" value={s.accent} onChange={(e) => set({ accent: e.target.value })} style={{ width: 64, height: 40 }} />
            <button className="btn btn-primary" style={{ ['--accent' as string]: s.accent, pointerEvents: 'none' } as React.CSSProperties}>
              Записаться
            </button>
            <span className="small muted">так будут выглядеть кнопки на витрине</span>
          </div>
        </Row>
        <Row label="Тема">
          <div className="picker-row">
            {([
              { v: 'light', label: 'Светлая', bg: '#faf7f2', text: 'rgba(26,23,18,.45)' },
              { v: 'dark', label: 'Тёмная', bg: '#171612', text: 'rgba(241,236,224,.45)' },
              { v: 'auto', label: 'Как у устройства', bg: 'linear-gradient(90deg,#faf7f2 50%,#171612 50%)', text: 'rgba(128,124,110,.6)' },
            ] as { v: S['theme']; label: string; bg: string; text: string }[]).map((t) => (
              <button
                key={t.v}
                type="button"
                className={`picker-item ${s.theme === t.v ? 'active' : ''}`}
                onClick={() => set({ theme: t.v })}
              >
                <span className="theme-mock" style={{ background: t.bg }}>
                  <span className="theme-mock-head" style={{ background: s.accent }} />
                  <span className="theme-mock-line" style={{ background: t.text, width: '72%' }} />
                  <span className="theme-mock-line" style={{ background: t.text, width: '52%' }} />
                </span>
                <div className="small">{t.label}</div>
              </button>
            ))}
          </div>
        </Row>
        <Row label="Размер карточек услуг">
          <CardSizePicker value={s.serviceCardSize} onChange={(v) => set({ serviceCardSize: v })} />
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            Меняет размер карточек услуг на главной и на странице «Услуги»: компактные — больше в ряд, крупные — просторнее.
          </p>
        </Row>
        <Row label="Размер карточек залов">
          <CardSizePicker value={s.hallCardSize} onChange={(v) => set({ hallCardSize: v })} />
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            Меняет размер карточек в блоке «Аренда зала» на главной и в «Аренде студии» на странице «Услуги».
          </p>
        </Row>
      </Block>

      <Block id="set-team" title="Команда на витрине" desc="Блок «Кто будет с вами» на главной странице студии.">
        <Toggle
          checked={s.teamEnabled}
          onChange={(v) => set({ teamEnabled: v })}
          label="Показывать блок команды"
          hint="Специалисты с фото — фото, без фото — инициалы. Кто попадёт в блок — во вкладке «Специалисты» ниже."
        />
        {s.teamEnabled && (
          <Row label="Вид карточек">
            <div className="picker-row">
              {([
                { v: 'card', label: 'Карточки' },
                { v: 'photo', label: 'Галерея' },
                { v: 'minimal', label: 'Список' },
              ] as { v: S['teamCardStyle']; label: string }[]).map((t) => (
                <button
                  key={t.v}
                  type="button"
                  className={`picker-item ${s.teamCardStyle === t.v ? 'active' : ''}`}
                  onClick={() => set({ teamCardStyle: t.v })}
                >
                  <span style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 72 }}>
                    {t.v === 'card' && <MiniAvatar bundle={bundle} />}
                    {t.v === 'photo' && <MiniAvatar bundle={bundle} rect />}
                    {t.v === 'minimal' && (
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <MiniAvatar bundle={bundle} />
                        <span>
                          <span className="mini-line" style={{ width: 46 }} />
                          <span className="mini-line" style={{ width: 30 }} />
                        </span>
                      </span>
                    )}
                  </span>
                  <div className="small">{t.label}</div>
                </button>
              ))}
            </div>
          </Row>
        )}
      </Block>

      <Block id="set-sections" title="Порядок блоков витрины" desc="Расставьте секции главной страницы так, как удобно вашей аудитории — заголовки выше команды или отзывы выше услуг.">
        <SectionsOrderEditor
          order={s.sectionsOrder ?? DEFAULT_SECTION_ORDER}
          onChange={(next) => set({ sectionsOrder: next })}
        />
        <Row label="Фоновое фото (hero)">
          <select
            value={s.heroPhotoId ?? ''}
            onChange={(e) => set({ heroPhotoId: e.target.value || undefined })}
          >
            <option value="">Первое фото «интерьер студии» (по умолчанию)</option>
            {bundle.portfolio
              .filter((p) => p.kind === 'image')
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.caption || p.category}
                </option>
              ))}
          </select>
          {s.heroPhotoUrl && (
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              Сейчас используется своё фото — выбранная здесь работа вступит в силу после его удаления.
            </p>
          )}
        </Row>
        {be.ownerUploadHeroPhoto && (
          <Row label="Своё фото фона (не из портфолио)">
            <HeroPhotoField
              slug={slug}
              value={s.heroPhotoUrl}
              studio={{ name: s.name, tagline: s.tagline, city: s.city }}
              onChange={persistHero}
            />
          </Row>
        )}
      </Block>

      <Block id="set-rules" title="Запись и правила отмены" desc="Что клиент выбирает при бронировании и условия бесплатной отмены.">
        <Toggle
          checked={s.specialistChoiceVisible !== false}
          onChange={(v) => set({ specialistChoiceVisible: v })}
          label="Клиент выбирает специалиста при записи"
          hint="Выключите — в форме записи не будет списка, свободный специалист подберётся автоматически."
        />
        <Toggle
          checked={s.hallChoiceVisible !== false}
          onChange={(v) => set({ hallChoiceVisible: v })}
          label="Клиент выбирает зал при записи"
          hint="Выключите — список залов скроется, сервер сам подберёт свободный зал, разрешённый для услуги."
        />
        <div className="grid grid-2">
          <div>
            <Toggle checked={s.modes.shoots} onChange={(v) => set({ modes: { ...s.modes, shoots: v } })} label="Съёмки" hint="Пакеты с фотографом: портрет, love story, свадьба…" />
            <Toggle checked={s.modes.rental} onChange={(v) => set({ modes: { ...s.modes, rental: v } })} label="Аренда студии" hint="Почасовая аренда залов без фотографа." />
            <Row label="Вечерний тариф с"><input type="time" value={s.eveningFrom} onChange={(e) => set({ eveningFrom: e.target.value })} /></Row>
          </div>
          <div>
            <Row label="Бесплатная отмена за (часов)">
              <NumberInput
                value={s.cancellation.freeHours}
                onChange={(next) => set({ cancellation: { ...s.cancellation, freeHours: next } })}
                min={0}
                max={336}
                step={1}
              />
            </Row>
            <Row label="Текст правил отмены"><textarea value={s.cancellation.text} onChange={(e) => set({ cancellation: { ...s.cancellation, text: e.target.value } })} /></Row>
          </div>
        </div>
      </Block>

      <Block id="set-travel" title="Выезды и сборы" desc="Фиксированные сборы и время дороги для съёмок вне студии. Клиент выбирает зону в форме записи.">
        <TravelZonesEditor zones={s.travelZones} onChange={(zones) => set({ travelZones: zones })} />
      </Block>

      <Block id="set-schedule" title={`График работы (${s.tz})`} desc="Часы работы по дням недели — на них строится сетка записи. Любое окно, не только пресеты.">
        <div className="grid grid-2">
          {WEEKDAY_ORDER.map((k) => {
            const win = s.schedule[k]
            return (
              <div className="field" key={k}>
                <label>{WEEKDAY_RU[k]}</label>
                {win ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="time"
                      value={win.open}
                      onChange={(e) => setDay(k, `${e.target.value}-${win.close}`)}
                      aria-label={`${WEEKDAY_RU[k]}: открытие`}
                    />
                    <span className="muted">—</span>
                    <input
                      type="time"
                      value={win.close}
                      onChange={(e) => setDay(k, `${win.open}-${e.target.value}`)}
                      aria-label={`${WEEKDAY_RU[k]}: закрытие`}
                    />
                    <button
                      type="button"
                      className="chip"
                      title="Сделать выходным"
                      onClick={() => setDay(k, null)}
                    >
                      Выходной
                    </button>
                  </div>
                ) : (
                  <button type="button" className="chip" onClick={() => setDay(k, '10:00-21:00')}>
                    + Рабочий день (10:00–21:00)
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <p className="small muted" style={{ margin: '8px 0 0' }}>
          Смена может идти через полночь: например, 22:00–06:00 — ночная съёмка до утра следующего дня.
        </p>
      </Block>

      <Block id="set-closed" title="Закрытые даты" desc="Праздники и отпуск — в эти дни запись недоступна.">
        <div className="chips" style={{ marginBottom: 10 }}>
          {s.closedDates.map((d) => (
            <span key={d} className="chip" style={{ cursor: 'default' }}>
              {d}{' '}
              <button type="button" onClick={() => set({ closedDates: s.closedDates.filter((x) => x !== d) })} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit' }}>✕</button>
            </span>
          ))}
          {s.closedDates.length === 0 && <span className="muted small">нет</span>}
        </div>
        <div className="filters" style={{ marginBottom: 0 }}>
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
      </Block>

      <Block id="set-vacations" title="Отпуска и закрытия ресурсов" desc="Отпуск специалиста или закрытие зала на диапазон дат: время освобождается для остальных ресурсов.">
        {be.ownerClosedPeriods ? (
          <ClosedPeriodsEditor bundle={bundle} slug={slug} />
        ) : (
          <p className="small muted">Доступно в режиме боевого API.</p>
        )}
      </Block>

      <Block id="set-cards" title="Информационные карточки" desc="До трёх карточек-ответов на главной: как проходит съёмка, сроки, гарантии.">
        {s.infoCards.map((c, i) => (
          <div className="card" key={i} style={{ marginBottom: 10 }}>
            <div className="booking-row">
              <Row label={`Заголовок ${i + 1}`}><input type="text" value={c.title} onChange={(e) => { const cards = [...s.infoCards]; cards[i] = { ...c, title: e.target.value }; set({ infoCards: cards }) }} /></Row>
              <button className="btn btn-sm" onClick={() => set({ infoCards: s.infoCards.filter((_, j) => j !== i) })}>Удалить</button>
            </div>
            <Row label="Текст"><textarea value={c.text} onChange={(e) => { const cards = [...s.infoCards]; cards[i] = { ...c, text: e.target.value }; set({ infoCards: cards }) }} /></Row>
          </div>
        ))}
        {s.infoCards.length < 3 && (
          <button className="btn btn-sm" onClick={() => set({ infoCards: [...s.infoCards, { icon: 'star', title: 'Новая карточка', text: '' }] })}>
            + Карточка
          </button>
        )}
        {s.infoCards.length >= 3 && <p className="small muted" style={{ margin: 0 }}>Максимум 3 карточки.</p>}
      </Block>

      <Block id="set-reviews" title="Отзывы" desc="Отзывы добавляете только вы — вручную, с согласия автора.">
        <Toggle checked={s.reviewsEnabled} onChange={(v) => set({ reviewsEnabled: v })} label="Показывать блок отзывов на витрине" />
        {s.reviews.map((r, i) => (
          <div className="card" key={i} style={{ marginBottom: 8 }}>
            <div className="booking-row">
              <span><strong>{r.author}</strong> <span className="muted">{'★'.repeat(r.rating)}</span></span>
              <button className="btn btn-sm" onClick={() => set({ reviews: s.reviews.filter((_, j) => j !== i) })}>Удалить</button>
            </div>
            <p className="small" style={{ margin: 0 }}>{r.text}</p>
          </div>
        ))}
        <div className="card" style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ marginBottom: 0 }}><label>Автор</label><input value={newReview.author} onChange={(e) => setNewReview({ ...newReview, author: e.target.value })} /></div>
            <div className="field" style={{ marginBottom: 0 }}><label>Оценка</label>
            <StarPicker value={newReview.rating} onChange={(v) => setNewReview({ ...newReview, rating: v })} />
          </div>
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
      </Block>

      <Block id="set-people" title="Специалисты" desc="Фотографы и видеографы студии: фото, лимиты съёмок в день, видимость в команде.">
        <SpecialistsEditor bundle={bundle} slug={slug} />
      </Block>

      <Block id="set-halls" title="Залы и тарифы" desc="Почасовые тарифы залов: будни/выходные, день/вечер.">
        {/* секция видна и без залов — иначе не создать первый зал */}
        {bundle.halls.length === 0 && <p className="small muted">Залов пока нет — добавьте первый.</p>}
        {(() => {
          const activeHalls = bundle.halls.filter((h) => h.active)
          if (activeHalls.length === 0) return null
          const rentals = bundle.services.filter((x) => x.kind === 'rental')
          const covered = (h: (typeof activeHalls)[number]) =>
            rentals.some((svc) => !svc.hallIds?.length || svc.hallIds.includes(h.id))
          const uncovered = activeHalls.filter((h) => !covered(h))
          if (uncovered.length === 0) return null
          return (
            <div className="card" style={{ marginBottom: 12, borderLeft: '4px solid #c8892a' }}>
              <strong>Залы без услуги аренды</strong>
              <p className="small" style={{ margin: '6px 0 0' }}>
                {rentals.length === 0
                  ? 'Залы есть, но услуги аренды нет — клиенты не смогут забронировать зал, карточки на витрине останутся только с фото и прайсом. Создайте услугу аренды в блоке «Услуги и пакеты» ниже.'
                  : `Для залов ${uncovered.map((h) => h.name).join(', ')} нет подходящей услуги аренды — кнопка брони на витрине не появится.`}
              </p>
            </div>
          )
        })()}
        <HallsEditor bundle={bundle} slug={slug} />
      </Block>

      <Block id="set-services" title="Услуги и пакеты" desc="Что видит клиент на витрине: цена, длительность, предоплата, ресурсы.">
        <ServicesEditor bundle={bundle} slug={slug} />
      </Block>

      <Block id="set-ical" title="Календарь-подписка (iCal)" desc="Заявки студии в вашем Google/Apple Calendar — только чтение.">
        {icalUrl ? (
          <div className="card" style={{ marginBottom: 0 }}>
            <p className="small muted" style={{ marginBottom: 6 }}>Секретный токен — не публикуйте ссылку:</p>
            <code className="small" style={{ wordBreak: 'break-all' }}>{icalUrl}</code>
          </div>
        ) : (
          <p className="small muted" style={{ marginBottom: 0 }}>Подключается вместе с Supabase (раздел README «Подключение Supabase»).</p>
        )}
      </Block>

      <div className="settings-save glass">
        <AsyncButton className="btn btn-primary" onClick={save}>
          {saved ? 'Сохранено ✓' : 'Сохранить настройки'}
        </AsyncButton>
        <button className="btn" onClick={() => jumpTo('set-common')}>↑ К началу</button>
      </div>
      <p className="small muted" style={{ marginTop: 14 }}>Slug {slug} меняется только администратором платформы.</p>
    </Section>
    </FlushRegistryCtx.Provider>
  )
}
