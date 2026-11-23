import { useEffect, useState } from 'react'

// Предпросмотр фото «как на витрине» до загрузки: владелец видит реальное
// кадрирование (object-fit: cover) и предупреждения по разрешению.

export type PhotoPreviewContext = 'specialist' | 'hall' | 'service' | 'portfolio' | 'hero'

type TeamStyle = 'card' | 'photo' | 'minimal'

type StudioLike = { name: string; tagline: string; city?: string }

const MIN: Record<PhotoPreviewContext, { w: number; h: number; rec: string; what: string }> = {
  specialist: { w: 400, h: 400, rec: '400×400', what: 'круглого аватара и карточки в форме записи' },
  hall: { w: 1024, h: 768, rec: '1024×768', what: 'карточки зала и галереи' },
  service: { w: 1024, h: 768, rec: '1024×768', what: 'обложки услуги' },
  portfolio: { w: 1600, h: 1200, rec: '1600×1200', what: 'плитки портфолио' },
  hero: { w: 1600, h: 900, rec: '1600×900', what: 'фона шапки' },
}

// Макет шапки витрины с реальными стилями .hero: телефон — узкий и высокий,
// чтобы владелец видел, какой центральный фрагмент кадра останется на мобильном
function HeroMock({ url, studio, phone = false }: { url: string; studio: StudioLike; phone?: boolean }) {
  return (
    <header
      className="hero"
      style={phone ? { position: 'relative', minHeight: 0, width: 180, height: 360 } : { position: 'relative', minHeight: 0, height: 240 }}
    >
      <div className="hero-media">
        <img src={url} alt="" />
      </div>
      <div className="hero-inner" style={{ padding: phone ? '14px 14px 18px' : '18px 20px 26px' }}>
        <div className="overline" style={{ color: '#fff', opacity: 0.85, ...(phone ? { fontSize: '0.6rem' } : {}) }}>
          {studio.city}
        </div>
        {phone ? (
          <>
            <h3 style={{ color: '#fff', margin: '2px 0', fontSize: '0.95rem', lineHeight: 1.2 }}>{studio.name}</h3>
            <p className="tagline" style={{ margin: 0, fontSize: '0.7rem' }}>{studio.tagline}</p>
          </>
        ) : (
          <>
            <h2 style={{ color: '#fff', margin: '2px 0' }}>{studio.name}</h2>
            <p className="tagline" style={{ margin: 0 }}>{studio.tagline}</p>
          </>
        )}
      </div>
    </header>
  )
}

function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file) {
      setUrl(null)
      return
    }
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  return url
}

function useImageSize(url: string | null): { w: number; h: number } | null {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    setSize(null)
    if (!url) return
    const img = new Image()
    img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = url
    return () => {
      img.onload = null
    }
  }, [url])
  return size
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} МБ`

function Mockups({
  url,
  context,
  label,
  sub,
  studio,
  teamStyle,
}: {
  url: string
  context: PhotoPreviewContext
  label: string
  sub: string
  studio: { name: string; tagline: string; city?: string }
  teamStyle: TeamStyle
}) {
  if (context === 'specialist') {
    return (
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <p className="small muted" style={{ margin: '0 0 6px' }}>Форма записи</p>
          <div className="specialist-cards" style={{ maxWidth: 340 }}>
            <button type="button" className="sp-card" tabIndex={-1}>
              <span className="sp-photo">
                <img src={url} alt="" />
              </span>
              <span className="sp-card-info">
                <b>{label}</b>
                <span className="small muted">{sub}</span>
              </span>
            </button>
          </div>
        </div>
        <div>
          <p className="small muted" style={{ margin: '0 0 6px' }}>Блок «Команда»</p>
          <div className={`team-grid team-${teamStyle}`} style={{ maxWidth: 360 }}>
            <div className="card team-card">
              <div className={`sp-photo ${teamStyle === 'photo' ? 'rect' : ''}`}>
                <img src={url} alt="" />
              </div>
              <div className="team-card-info">
                <b>{label}</b>
                <div className="small muted">{sub}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (context === 'hall') {
    return (
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <p className="small muted" style={{ margin: '0 0 6px' }}>Выбор зала</p>
          <div className="hall-cards" style={{ maxWidth: 270 }}>
            <div className="sp-card svc hall-card">
              <img src={url} alt="" className="svc-img" />
              <span className="sp-card-info">
                <b>{label}</b>
                <span className="small muted">{sub}</span>
              </span>
              <span className="hall-photo-link">ℹ фото и цены</span>
            </div>
          </div>
        </div>
        <div>
          <p className="small muted" style={{ margin: '0 0 6px' }}>Все фото зала (попап)</p>
          <div className="hall-modal-photos" style={{ maxWidth: 360 }}>
            <img src={url} alt="" />
          </div>
        </div>
      </div>
    )
  }

  if (context === 'service') {
    return (
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <p className="small muted" style={{ margin: '0 0 6px' }}>Форма записи</p>
          <div className="service-cards" style={{ maxWidth: 270 }}>
            <button type="button" className="sp-card svc" tabIndex={-1}>
              <img src={url} alt="" className="svc-img" />
              <span className="sp-card-info">
                <b>{label}</b>
                <span className="small muted">{sub}</span>
              </span>
            </button>
          </div>
        </div>
        <div>
          <p className="small muted" style={{ margin: '0 0 6px' }}>Главная страница</p>
          <div className="card" style={{ maxWidth: 380 }}>
            <div className="overline">Услуги</div>
            <h3 style={{ marginTop: 2 }}>{label}</h3>
            <img
              src={url}
              alt=""
              style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'cover', borderRadius: 12, marginBottom: 8 }}
            />
            <p className="small muted" style={{ margin: 0 }}>{sub}</p>
          </div>
        </div>
      </div>
    )
  }

  if (context === 'hero') {
    return (
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <p className="small muted" style={{ margin: '0 0 6px' }}>Шапка сайта — компьютер</p>
          <HeroMock url={url} studio={studio} />
        </div>
        <div>
          <p className="small muted" style={{ margin: '0 0 6px' }}>Телефон — остаётся центральный фрагмент кадра</p>
          <HeroMock url={url} studio={studio} phone />
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div>
        <p className="small muted" style={{ margin: '0 0 6px' }}>Галерея работ</p>
        <div className="gallery" style={{ columns: 1, maxWidth: 320 }}>
          <figure className="gallery-item" style={{ margin: 0 }}>
            <img src={url} alt="" />
            <figcaption className="cap">{label}</figcaption>
          </figure>
        </div>
      </div>
      <div>
        <p className="small muted" style={{ margin: '0 0 6px' }}>Шапка сайта (если выбрать фоном)</p>
        <HeroMock url={url} studio={studio} />
      </div>
    </div>
  )
}

export function PhotoPreviewModal({
  files,
  context,
  label,
  sub,
  studio,
  teamStyle = 'card',
  onConfirm,
  onCancel,
  onPickAgain,
}: {
  files: File[]
  context: PhotoPreviewContext
  label?: string
  sub?: string
  studio?: { name: string; tagline: string; city?: string }
  teamStyle?: TeamStyle
  onConfirm: () => void
  onCancel: () => void
  onPickAgain: () => void
}) {
  const first = files[0] ?? null
  const url = useObjectUrl(first)
  const size = useImageSize(url)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const meta = MIN[context]
  const small = size !== null && (size.w < meta.w || size.h < meta.h)
  const ratio = size ? size.w / size.h : 0
  const cropNotes: string[] = []
  if (context === 'specialist' && size && (ratio < 0.8 || ratio > 1.25)) {
    cropNotes.push('Кадр не квадратный — в круглом аватаре края срежутся.')
  }
  if ((context === 'hall' || context === 'service') && size && (ratio < 1.2 || ratio > 2.2)) {
    cropNotes.push('Кадр не горизонтальный — в карточке часть фото обрежется (object-fit: cover).')
  }
  if (context === 'portfolio' && size) {
    if (size.w < 1920) {
      cropNotes.push('Для фона шапки (hero) рекомендуем от 1920 px по ширине — иначе на широком экране будет мыльно.')
    }
    if (ratio < 1.3) {
      cropNotes.push('Портретный кадр в шапке обрежется по бокам; в галерее покажется целиком.')
    }
  }
  if (context === 'hero' && size) {
    if (size.w < 1600) {
      cropNotes.push('Для чёткого фона на широком экране рекомендуем от 1600 px по ширине.')
    }
    if (ratio < 1.3) {
      cropNotes.push('Портретный кадр в шапке обрежется по бокам: на телефоне останется центральная часть.')
    }
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: 760, width: '100%', maxHeight: '92vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" onClick={onCancel} aria-label="Закрыть">✕</button>
        <h3 style={{ marginBottom: 4 }}>Так фото будет выглядеть на странице</h3>
        <p className="small muted" style={{ margin: '0 0 14px' }}>
          Пока ничего не загружено — можно выбрать другой файл.
        </p>

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ flex: '1 1 300px', minWidth: 260 }}>
            {url && (
              <Mockups
                url={url}
                context={context}
                label={label || 'Название'}
                sub={sub || ''}
                studio={studio ?? { name: 'Название студии', tagline: 'Короткий слоган студии' }}
                teamStyle={teamStyle}
              />
            )}
          </div>
          <div style={{ flex: '1 1 240px', minWidth: 220 }}>
            <div className="card" style={{ padding: 14 }}>
              <b className="small">Параметры файла</b>
              <p className="small" style={{ margin: '8px 0 0' }}>
                {first ? first.name : '—'}
                <br />
                {size ? `${size.w}×${size.h} px` : 'определяем размер…'}
                {first ? ` · ${mb(first.size)}` : ''}
              </p>
              <p className="small muted" style={{ margin: '8px 0 0' }}>
                Рекомендуем от {meta.rec} для {meta.what}.
              </p>
              {size && (
                <p className="small" style={{ margin: '8px 0 0', color: small ? 'var(--warn)' : 'var(--muted)' }}>
                  {small
                    ? `Разрешение меньше рекомендованного — на витрине может быть нечётко.`
                    : 'Разрешение достаточное — на витрине будет чётко.'}
                </p>
              )}
              {cropNotes.map((n) => (
                <p key={n} className="small" style={{ margin: '8px 0 0', color: 'var(--warn)' }}>
                  {n}
                </p>
              ))}
              {files.length > 1 && (
                <p className="small muted" style={{ margin: '8px 0 0' }}>
                  Выбрано фото: {files.length}. Проверяем первое — остальные появятся в галерее, их можно удалить и переставить местами.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="chips" style={{ marginBottom: 0 }}>
          <button className="btn btn-primary" onClick={onConfirm}>Сохранить фото</button>
          <button className="btn" onClick={onPickAgain}>Выбрать другое</button>
          <button className="btn" onClick={onCancel}>Отмена</button>
        </div>
      </div>
    </div>
  )
}
