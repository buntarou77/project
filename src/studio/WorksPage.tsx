import { useMemo, useRef, useState } from 'react'
import type { StudioBundle } from '@/backend'
import type { PortfolioItem as PfItem } from '@/core/types'
import { Section, Empty } from '@/ui/common'

function Gallery({ items, onOpen }: { items: PfItem[]; onOpen: (i: number) => void }) {
  return (
    <div className="gallery">
      {items.map((it, i) => (
        <figure className="gallery-item" key={it.id} style={{ margin: 0 }} onClick={() => onOpen(i)}>
          <img
            src={it.src}
            srcSet={it.srcset}
            alt={it.caption || it.category}
            loading="lazy"
            decoding="async"
          />
          <figcaption className="cap">{it.caption}</figcaption>
        </figure>
      ))}
    </div>
  )
}

function Lightbox({
  items,
  index,
  onClose,
  onNav,
}: {
  items: PfItem[]
  index: number
  onClose: () => void
  onNav: (next: number) => void
}) {
  const touchX = useRef<number | null>(null)
  const item = items[index]
  if (!item) return null
  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current === null) return
        const dx = e.changedTouches[0].clientX - touchX.current
        if (Math.abs(dx) > 48) onNav((index + (dx < 0 ? 1 : -1) + items.length) % items.length)
        touchX.current = null
      }}
    >
      <button className="close" onClick={onClose} aria-label="Закрыть">✕</button>
      <button className="arrow prev" onClick={() => onNav((index - 1 + items.length) % items.length)} aria-label="Назад">‹</button>
      <img src={item.src} alt={item.caption} />
      <button className="arrow next" onClick={() => onNav((index + 1) % items.length)} aria-label="Вперёд">›</button>
      <div className="counter">{index + 1} / {items.length}{item.caption ? ` · ${item.caption}` : ''}</div>
    </div>
  )
}

export default function WorksPage({ bundle }: { bundle: StudioBundle }) {
  const categories = useMemo(
    () => [...new Set(bundle.portfolio.map((p) => p.category))],
    [bundle.portfolio]
  )
  const [cat, setCat] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<number | null>(null)

  const images = bundle.portfolio.filter((p) => p.kind === 'image' && (!cat || p.category === cat))
  const videos = bundle.portfolio.filter((p) => p.kind === 'video' && (!cat || p.category === cat))

  return (
    <Section>
      <div className="overline">Портфолио</div>
      <h2>Работы</h2>
      <div className="chips" style={{ marginBottom: 22 }}>
        <button className={`chip ${cat === null ? 'active' : ''}`} onClick={() => setCat(null)}>Все</button>
        {categories.map((c) => (
          <button key={c} className={`chip ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>{c}</button>
        ))}
      </div>

      {videos.length > 0 && (
        <div className="grid grid-3" style={{ marginBottom: 22 }}>
          {videos.map((v) => (
            <a
              key={v.id}
              className="card"
              style={{ padding: 0, overflow: 'hidden', textDecoration: 'none' }}
              href={v.videoUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <img src={v.src} alt={v.caption} loading="lazy" style={{ aspectRatio: '16/9', objectFit: 'cover' }} />
              <div style={{ padding: '10px 14px' }}>
                <strong className="small">▶ {v.caption}</strong>
                <p className="muted small" style={{ margin: 0 }}>Смотреть по ссылке</p>
              </div>
            </a>
          ))}
        </div>
      )}

      {images.length === 0 ? <Empty>В этой категории пока нет работ</Empty> : (
        <Gallery items={images} onOpen={setLightbox} />
      )}

      {lightbox !== null && images[lightbox] && (
        <Lightbox
          items={images as PfItem[]}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onNav={setLightbox}
        />
      )}
    </Section>
  )
}
