import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { Empty, Section, Spinner } from '@/ui/common'
import { PORTFOLIO_CATEGORIES } from '@/core/types'

export default function OwnerPortfolio({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [cat, setCat] = useState('портрет')
  const [caption, setCaption] = useState('')
  const [kind, setKind] = useState<'image' | 'video'>('image')
  const [videoUrl, setVideoUrl] = useState('')

  const { data: portfolio } = useQuery({
    queryKey: ['studio', slug],
    queryFn: () => be.loadStudio(slug),
  })

  async function add() {
    const file = fileRef.current?.files?.[0]
    if (kind === 'image' && !file) return
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
    } finally {
      setBusy(false)
    }
  }

  async function replacePhoto(id: string, file: File) {
    const item = bundle.portfolio.find((p) => p.id === id)
    if (!item) return
    setBusy(true)
    try {
      const up = await be.ownerUploadPortfolioPhoto(slug, file)
      await be.ownerUpsertPortfolioItem(slug, { ...item, src: up.src, srcset: up.srcset })
      qc.invalidateQueries({ queryKey: ['studio', slug] })
    } finally {
      setBusy(false)
    }
  }

  async function patch(id: string, changes: { caption?: string; category?: string; sort?: number }) {
    const item = bundle.portfolio.find((p) => p.id === id)
    if (!item) return
    await be.ownerUpsertPortfolioItem(slug, { ...item, ...changes })
    qc.invalidateQueries({ queryKey: ['studio', slug] })
  }

  async function remove(id: string) {
    if (!confirm('Удалить фотографию? Остальные не изменятся.')) return
    await be.ownerDeletePortfolioItem(slug, id)
    qc.invalidateQueries({ queryKey: ['studio', slug] })
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
              <input ref={fileRef} type="file" accept="image/*" />
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
                    onChange={(e) => e.target.files?.[0] && replacePhoto(p.id, e.target.files[0])}
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
              <button className="chip" onClick={() => patch(p.id, { sort: p.sort - 15 })}>↑</button>
              <button className="chip" onClick={() => remove(p.id)}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}
