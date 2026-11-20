import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Hall, Service } from '@/core/types'
import { money } from './format'
import { Lightbox } from './common'

// Попап зала: фото, вместимость, тарифы. Клик по фото — на весь экран.
// services — услуги аренды, доступные этому залу: клиент выбирает вариант
// (например, «аренда зала» и «аренда со специалистом»).
export function HallModal({ hall, slug, services, onClose }: { hall: Hall; slug: string; services?: Service[]; onClose: () => void }) {
  const [photoIndex, setPhotoIndex] = useState<number | null>(null)
  const photos = hall.photos ?? []

  useEffect(() => {
    if (photoIndex !== null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [photoIndex, onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card hall-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть">✕</button>
        <h3 style={{ marginBottom: 4 }}>{hall.name}</h3>
        <p className="small muted" style={{ margin: '0 0 12px' }}>до {hall.capacity} человек</p>
        {photos.length > 0 && (
          <div className="hall-modal-photos">
            {photos.map((src, i) => (
              <img key={src} src={src} alt={`${hall.name} — фото ${i + 1}`} onClick={() => setPhotoIndex(i)} />
            ))}
          </div>
        )}
        {photos.length > 0 && <p className="small muted" style={{ margin: '6px 0 12px' }}>клик по фото — на весь экран</p>}
        <table className="hours-table">
          <tbody>
            <tr><td>Будни, день</td><td>{money(hall.rates.weekday.day)}/час</td></tr>
            <tr><td>Будни, вечер</td><td>{money(hall.rates.weekday.evening)}/час</td></tr>
            <tr><td>Выходные, день</td><td>{money(hall.rates.weekend.day)}/час</td></tr>
            <tr><td>Выходные, вечер</td><td>{money(hall.rates.weekend.evening)}/час</td></tr>
          </tbody>
        </table>
        {services !== undefined && (services.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
            {services.map((svc) => (
              <Link
                key={svc.id}
                className="btn btn-primary btn-block"
                to={`/s/${slug}/book?mode=rental&service=${svc.id}&hall=${hall.id}`}
                onClick={onClose}
              >
                {svc.name}
              </Link>
            ))}
          </div>
        ) : (
          <p className="small muted" style={{ margin: '14px 0 0' }}>
            Запись на аренду пока недоступна: для этого зала ещё не создана услуга аренды.
          </p>
        ))}
      </div>
      {photoIndex !== null && photos.length > 0 && (
        <Lightbox
          items={photos.map((src, i) => ({ src, alt: `${hall.name} — фото ${i + 1}` }))}
          index={photoIndex}
          onClose={() => setPhotoIndex(null)}
          onNav={setPhotoIndex}
        />
      )}
    </div>
  )
}
