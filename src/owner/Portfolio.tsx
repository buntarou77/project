import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { Empty, Section, Spinner, ConfirmDialog } from '@/ui/common'
import { toast, toastError } from '@/ui/toast'
import { PORTFOLIO_CATEGORIES } from '@/core/types'
import { PhotoPreviewModal } from '@/ui/PhotoPreview'

export default function OwnerPortfolio({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [cat, setCat] = useState('портрет')
  const [caption, setCaption] = useState('')
  const [kind, setKind] = useState<'image' | 'video'>('image')
  const [videoUrl, setVideoUrl] = useState('')
  const [delTarget, setDelTarget] = useState<string | null>(null)
  // preview.target = id работы при замене фото; null — добавление новой
  const [preview, setPreview] = useState<{ files: File[]; target: string | null; input?: HTMLInputElement } | null>(null)

  const { data: portfolio } = useQuery({
    queryKey: ['studio', slug],
    queryFn: () => be.loadStudio(slug),
  })

  async function doAdd(file: File | null) {
    setBusy(true)
    try {
      let src = ''
      let srcset: string | undefined
      if (file) {
        const up = await be.ownerUploadPortfolioPhoto(slug, file)
        src = up.src
        srcset = up.srcset
      } else {
        src = portfolio?.portfolio.find((p) => p.kind === 'image')?.src ?? ''
      }
      await be.ownerUpsertPortfolioItem(slug, {
        id: `pf-${Date.now()}`,
        category: cat,
        caption,
        kind,
        videoUrl: kind === 'video' ? videoUrl : undefined,
        src,
        srcset,
        sort: (portfolio?.portfolio.length ?? 0) + 1,
      })
      setCaption('')
      if (fileRef.current) fileRef.current.value = ''
      qc.invalidateQueries({ queryKey: ['studio', slug] })
      toast(kind === 'video' ? 'Видео добавлено' : 'Фото добавлено')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  function add() {
    const file = fileRef.current?.files?.[0] ?? null
    if (kind === 'video') {
      void doAdd(null)
      return
    }
    if (!file) return
    setPreview({ files: [file], target: null })
  }

  async function replacePhoto(id: string, file: File) {
    const item = bundle.portfolio.find((p) => p.id === id)
    if (!item) return
    setBusy(true)
    try {
      const up = await be.ownerUploadPortfolioPhoto(slug, file)
      await be.ownerUpsertPortfolioItem(slug, { ...item, src: up.src, srcset: up.srcset })
      qc.invalidateQueries({ queryKey: ['studio', slug] })
      toast('Фото заменено')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  async function patch(id: string, changes: { caption?: string; category?: string; sort?: number }) {
    const item = bundle.portfolio.find((p) => p.id === id)
    if (!item) return
    try {
      await be.ownerUpsertPortfolioItem(slug, { ...item, ...changes })
      qc.invalidateQueries({ queryKey: ['studio', slug] })
      toast('Сохранено')
    } catch (e) {
      toastError(e)
    }
  }

  async function remove(id: string) {
    try {
      await be.ownerDeletePortfolioItem(slug, id)
      qc.invalidateQueries({ queryKey: ['studio', slug] })
      toast('Карточка удалена')
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <Section>
      <h2>Портфолио</h2>
      <p className="small muted">
        Загружая фото, убедитесь, что у людей на снимках есть согласие на публикацию.
      </p>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="grid grid-2">
          <div className="field">
            <label>Категория</label>
            <select value={cat} onChange={(e) => setCat(e.target.value)}>
              {PORTFOLIO_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Подпись</label>
            <input type="text" value={caption} onChange={(e) => setCaption(e.target.value)} />
          </div>
          <div className="field">
            <label>Тип</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as 'image' | 'video')}>
              <option value="image">Фото</option>
              <option value="video">Видео (ссылка)</option>
            </select>
          </div>
          {kind === 'video' ? (
            <div className="field">
              <label>Ссылка на видео</label>
              <input type="url" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} />
            </div>
          ) : (
            <div className="field">
              <label>Файл (jpg/png, сожмём на устройстве)</label>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={(e) => {
                  // «Выбрать другое» из предпросмотра: обновляем файл в модалке
                  const f = e.target.files?.[0]
                  if (f && preview && preview.target === null) setPreview({ files: [f], target: null })
                }}
              />
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={add} disabled={busy}>{busy ? 'Загружаем…' : 'Добавить карточку'}</button>
      </div>

      {!portfolio && <Spinner />}
      {bundle.portfolio.length === 0 && <Empty>Пока нет работ</Empty>}
      <div className="grid grid-3">
        {bundle.portfolio.map((p) => (
          <div className="card" key={p.id} style={{ padding: 12 }}>
            {p.kind === 'image' ? (
              <>
                <img src={p.src} alt={p.caption} style={{ borderRadius: 10, aspectRatio: '4/3', objectFit: 'cover', width: '100%' }} />
                <label className="btn btn-sm" style={{ display: 'inline-flex', marginTop: 8, cursor: 'pointer' }}>
                  Заменить фото
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) setPreview({ files: [f], target: p.id, input: e.currentTarget })
                      e.target.value = ''
                    }}
                  />
                </label>
              </>
            ) : (
              <div className="muted small">▶ видео · {p.videoUrl?.slice(0, 32)}…</div>
            )}
            <div className="field" style={{ marginTop: 8, marginBottom: 6 }}>
              <input type="text" defaultValue={p.caption} onBlur={(e) => e.target.value !== p.caption && patch(p.id, { caption: e.target.value })} />
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <select defaultValue={p.category} onChange={(e) => patch(p.id, { category: e.target.value })} className="chip" style={{ flex: 1 }}>
                {PORTFOLIO_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <button className="chip" onClick={() => patch(p.id, { sort: p.sort - 15 })} title="Выше">↑</button>
              <button className="chip" onClick={() => patch(p.id, { sort: p.sort + 15 })} title="Ниже">↓</button>
              <button className="chip" onClick={() => setDelTarget(p.id)}>✕</button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={delTarget !== null}
        title="Удалить фотографию?"
        text="Карточка исчезнет с витрины. Остальные работы не изменятся."
        onConfirm={() => {
          if (delTarget) void remove(delTarget)
          setDelTarget(null)
        }}
        onCancel={() => setDelTarget(null)}
      />

      {preview && (
        <PhotoPreviewModal
          files={preview.files}
          context="portfolio"
          label={
            preview.target
              ? bundle.portfolio.find((p) => p.id === preview.target)?.caption || caption || 'Работа'
              : caption || cat
          }
          studio={{ name: bundle.settings.name, tagline: bundle.settings.tagline, city: bundle.settings.city }}
          onCancel={() => setPreview(null)}
          onPickAgain={() => {
            if (preview.target) preview.input?.click()
            else fileRef.current?.click()
          }}
          onConfirm={() => {
            const p = preview
            setPreview(null)
            if (p.target) void replacePhoto(p.target, p.files[0])
            else void doAdd(p.files[0])
          }}
        />
      )}
    </Section>
  )
}
