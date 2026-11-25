import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import type { StudioBundle } from '@/backend/types'
import { Section } from '@/ui/common'
import { HallModal } from '@/ui/hallModal'
import { rentalServicesForHall } from '@/ui/rentalServices'
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
  const rentalServices = bundle.services.filter((x) => x.kind === 'rental').sort((a, b) => a.sort - b.sort)
  const hasShootServices = s.modes.shoots && shoots.length > 0
  const hasRentalServices = s.modes.rental && rentalServices.length > 0
  const serviceCardSize = s.serviceCardSize ?? 'normal'
  const hallCardSize = s.hallCardSize ?? 'normal'
  const servicesTitle = hasShootServices
    ? hasRentalServices ? 'Услуги и аренда' : 'Пакеты съёмки'
    : 'Услуги аренды'
  const rentalAddonIds = new Set(
    bundle.services.filter((x) => x.kind === 'rental').flatMap((x) => x.addonIds ?? [])
  )

  return (
    <>
      {(hasShootServices || hasRentalServices) && (
        <Section>
          <div className="overline">Услуги</div>
          <h2>{servicesTitle}</h2>
          <div className={`service-grid service-grid-${serviceCardSize}`}>
            {hasShootServices && shoots.map((svc) => {
              const svcHalls = bundle.halls.filter(
                (h) => h.active && (!svc.hallIds?.length || svc.hallIds.includes(h.id))
              )
              return (
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
                  <strong style={{ whiteSpace: 'nowrap' }}>{svc.priceType === 'fixed' ? money(svc.price) : 'почасово'}</strong>
                </div>
                <p className="muted small">{svc.description}</p>
                <ul className="small" style={{ margin: '0 0 12px 18px', padding: 0 }}>
                  {svc.includes.map((i) => <li key={i}>{i}</li>)}
                </ul>
                <p className="small" style={{ marginBottom: 6 }}>
                  {svc.fullDay
                    ? 'Весь день'
                    : svc.durationMin % 60 === 0
                      ? hoursLabel(svc.durationMin / 60)
                      : `${Math.floor(svc.durationMin / 60)} ч ${svc.durationMin % 60} мин`}
                  {svc.deliverableText ? ` · ${svc.deliverableText}` : ''}
                  {svc.deadlineDays ? ` · сдача за ${svc.deadlineDays} дн.` : ''}
                </p>
                {(svc.needsHall || svc.kind === 'rental') && svcHalls.length > 0 && (
                  <p className="small muted" style={{ marginBottom: 14 }}>
                    {svc.priceType === 'hourly'
                      ? `+ зал по тарифу — от ${money(Math.min(...svcHalls.map((h) => h.rates.weekday.day)))}/час`
                      : 'Зал включён в стоимость.'}
                  </p>
                )}
                <p className="small muted" style={{ marginBottom: 14 }}>
                  Предоплата: {svc.prepayment.type === 'percent' ? `${svc.prepayment.value}%` : money(svc.prepayment.value)}
                </p>
                <Link to={`/s/${s.slug}/book?service=${svc.id}`} className="btn btn-primary btn-block">Выбрать</Link>
              </div>
              )
            })}
            {hasRentalServices && rentalServices.map((svc) => {
              const svcHalls = bundle.halls.filter(
                (h) => h.active && (!svc.hallIds?.length || svc.hallIds.includes(h.id))
              )
              const priceHint =
                svc.priceType === 'fixed'
                  ? money(svc.price)
                  : svcHalls.length > 0
                    ? `от ${money(Math.min(...svcHalls.map((h) => h.rates.weekday.day)))}/час`
                    : 'по тарифу зала'
              return (
                <Link
                  key={svc.id}
                  to={`/s/${s.slug}/book?mode=rental&service=${svc.id}`}
                  className="card"
                  style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}
                >
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
                    <strong style={{ whiteSpace: 'nowrap' }}>{priceHint}</strong>
                  </div>
                  <p className="muted small">{svc.description}</p>
                  {svc.includes.length > 0 && (
                    <ul className="small" style={{ margin: '0 0 12px 18px', padding: 0 }}>
                      {svc.includes.map((i) => <li key={i}>{i}</li>)}
                    </ul>
                  )}
                  <p className="small muted" style={{ marginBottom: 10 }}>
                    {svc.needsSpecialist ? 'Со специалистом · ' : ''}зал выбирается при записи
                  </p>
                  <span className="btn btn-primary">Забронировать</span>
                </Link>
              )
            })}
          </div>
        </Section>
      )}

      {s.modes.rental && bundle.halls.some((h) => h.active) && (
        <Section>
          <div className="overline">Аренда</div>
          <h2>Аренда студии</h2>
          <div className={`hall-grid hall-grid-${hallCardSize}`}>
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
                  <div className={`hall-card-photos${hall.photos!.length === 1 ? ' single' : ''}`}>
                    {hall.photos!.slice(0, 2).map((src) => (
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
                {(() => {
                  const options = rentalServicesForHall(bundle.services, hall, s.modes.rental)
                  if (options.length === 1) {
                    return (
                      <Link
                        to={`/s/${s.slug}/book?mode=rental&service=${options[0].id}&hall=${hall.id}`}
                        className="btn btn-primary btn-block"
                        style={{ marginTop: 14 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        Арендовать зал
                      </Link>
                    )
                  }
                  if (options.length > 1) {
                    return (
                      <button
                        className="btn btn-primary btn-block"
                        style={{ marginTop: 14 }}
                        onClick={(e) => {
                          e.stopPropagation()
                          setHallModalId(hall.id)
                        }}
                      >
                        Арендовать зал
                      </button>
                    )
                  }
                  return (
                    <p className="small muted" style={{ margin: '14px 0 0' }}>
                      Бронь пока недоступна
                    </p>
                  )
                })()}
              </div>
            ))}
          </div>
          {(() => {
            const rentalAddons = bundle.addons.filter((a) => rentalAddonIds.has(a.id))
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
      {hallModal && (
        <HallModal
          hall={hallModal}
          slug={s.slug}
          services={rentalServicesForHall(bundle.services, hallModal, s.modes.rental)}
          onClose={() => setHallModalId(null)}
        />
      )}
    </>
  )
}
