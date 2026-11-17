import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { StudioBundle } from '@/backend/types'
import { Section } from '@/ui/common'
import { HallModal } from '@/ui/hallModal'
import { money, hoursLabel } from '@/ui/format'

export default function ServicesPage({ bundle }: { bundle: StudioBundle }) {
  const { settings: s } = bundle
  const location = useLocation()
  const [hallModalId, setHallModalId] = useState<string | null>(null)
  const hallModal = bundle.halls.find((h) => h.id === hallModalId) ?? null

  // переход «все фото зала» из формы записи: скроллим к карточке зала по #hash
  useEffect(() => {
    if (!window.location.hash) return
    const el = document.getElementById(window.location.hash.slice(1))
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150)
  }, [location.key])
  const shoots = bundle.services.filter((x) => x.kind === 'shoot').sort((a, b) => a.sort - b.sort)
  const rental = bundle.services.find((x) => x.kind === 'rental')

  return (
    <>
      {s.modes.shoots && (
        <Section>
          <div className="overline">Услуги</div>
          <h2>Пакеты съёмки</h2>
          <div className="grid grid-2">
            {shoots.map((svc) => (
              <div className="card" key={svc.id}>
                {svc.photoUrl && (
                  <img
                    src={svc.photoUrl}
                    alt={svc.name}
                    loading="lazy"
                    decoding="async"
                    style={{ width: '100%', aspectRatio: '16 / 10', objectFit: 'cover', borderRadius: 12, marginBottom: 12 }}
                  />
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                  <h3 style={{ marginBottom: 2 }}>{svc.name}</h3>
                  <strong style={{ whiteSpace: 'nowrap' }}>{money(svc.price)}</strong>
                </div>
                <p className="muted small">{svc.description}</p>
                <ul className="small" style={{ margin: '0 0 12px 18px', padding: 0 }}>
                  {svc.includes.map((i) => <li key={i}>{i}</li>)}
                </ul>
                <p className="small" style={{ marginBottom: 6 }}>
                  {svc.fullDay ? 'Весь день' : hoursLabel(Math.round(svc.durationMin / 60))}
                  {svc.deliverableText ? ` · ${svc.deliverableText}` : ''}
                  {svc.deadlineDays ? ` · сдача за ${svc.deadlineDays} дн.` : ''}
                </p>
                {svc.needsHall && bundle.halls.filter((h) => h.active).length > 0 && (
                  <p className="small muted" style={{ marginBottom: 14 }}>
                    + зал по тарифу — от {money(Math.min(...bundle.halls.filter((h) => h.active).map((h) => h.rates.weekday.day)))}/час
                  </p>
                )}
                <p className="small muted" style={{ marginBottom: 14 }}>
                  Предоплата: {svc.prepayment.type === 'percent' ? `${svc.prepayment.value}%` : money(svc.prepayment.value)}
                </p>
                <Link to={`/s/${s.slug}/book?service=${svc.id}`} className="btn btn-primary btn-block">Выбрать</Link>
              </div>
            ))}
          </div>
        </Section>
      )}

      {s.modes.rental && rental && (
        <Section>
          <div className="overline">Аренда</div>
          <h2>Аренда студии</h2>
          <div className="grid grid-2">
            {bundle.halls.filter((h) => h.active).map((hall) => (
              <div
                className="card hall-tile"
                key={hall.id}
                id={`hall-${hall.id}`}
                role="button"
                tabIndex={0}
                onClick={() => setHallModalId(hall.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setHallModalId(hall.id)}
              >
                {(hall.photos?.length ?? 0) > 0 && (
                  <div className="hall-photos-grid">
                    {hall.photos!.map((src) => (
                      <img key={src} src={src} alt={hall.name} loading="lazy" decoding="async" />
                    ))}
                  </div>
                )}
                <h3 style={{ marginBottom: 2 }}>{hall.name}</h3>
                <p className="muted small">до {hall.capacity} человек</p>
                <table className="hours-table">
                  <tbody>
                    <tr><td>Будни, день</td><td>{money(hall.rates.weekday.day)}/час</td></tr>
                    <tr><td>Будни, вечер (от {s.eveningFrom})</td><td>{money(hall.rates.weekday.evening)}/час</td></tr>
                    <tr><td>Выходные, день</td><td>{money(hall.rates.weekend.day)}/час</td></tr>
                    <tr><td>Выходные, вечер</td><td>{money(hall.rates.weekend.evening)}/час</td></tr>
                  </tbody>
                </table>
                <Link
                  to={`/s/${s.slug}/book?mode=rental&hall=${hall.id}`}
                  className="btn btn-primary btn-block"
                  style={{ marginTop: 14 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  Забронировать зал
                </Link>
              </div>
            ))}
          </div>
          {(() => {
            const rentalAddons = bundle.addons.filter((a) =>
              rental.addonIds ? rental.addonIds.includes(a.id) : a.appliesTo !== 'shoot'
            )
            if (rentalAddons.length === 0) return null
            return (
              <p className="small muted">
                Дополнительно: {rentalAddons.map((a) => `${a.name} (+${money(a.price)}${a.unit === 'hour' ? '/час' : ''})`).join(', ')}
              </p>
            )
          })()}
        </Section>
      )}

      <Section>
        <div className="card">
          <div className="overline">Условия</div>
          <h3 style={{ marginBottom: 8 }}>Правила отмены</h3>
          <p className="small" style={{ marginBottom: 0 }}>{s.cancellation.text}</p>
        </div>
      </Section>
      {hallModal && <HallModal hall={hallModal} slug={s.slug} onClose={() => setHallModalId(null)} />}
    </>
  )
}
