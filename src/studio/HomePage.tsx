import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import type { StudioBundle } from '@/backend/types'
import { Section } from '@/ui/common'
import { HallModal } from '@/ui/hallModal'
import { money, scheduleRows } from '@/ui/format'
import { contactHref, CONTACT_LABELS } from '@/lib/links'
import { rentalServicesForHall } from '@/ui/rentalServices'
import { heroImageFor } from '@/ui/hero'
import { DEFAULT_SECTION_ORDER, type Hall, type SectionKey } from '@/core/types'

export default function HomePage({ bundle }: { bundle: StudioBundle }) {
  const { settings: s } = bundle
  const [hallModal, setHallModal] = useState<Hall | null>(null)
  // hero: своё фото владельца → выбранная работа → первый «интерьер студии» → первая работа
  const hero = heroImageFor(s, bundle.portfolio)

  return (
    <>
      <header className="hero">
        <div className="hero-media">
          {hero ? (
            <img src={hero.src} srcSet={hero.srcset || undefined} sizes="100vw" alt="" loading="eager" decoding="async" />
          ) : (
            <div style={{ background: 'linear-gradient(160deg, #2b2620, #57503f)' }} />
          )}
        </div>
        <div className="hero-inner">
          <div className="overline" style={{ color: '#fff', opacity: 0.85 }}>{s.city}</div>
          <h1>{s.name}</h1>
          <p className="tagline">{s.tagline}</p>
          <div className="hero-cta">
            <Link to="book" className="btn btn-glass" style={{ color: '#fff', padding: '16px 34px', fontSize: '1.05rem' }}>
              Записаться
            </Link>
            <a href={`tel:${s.phone.replace(/[^+\d]/g, '')}`} className="btn btn-glass" style={{ color: '#fff' }}>
              {s.phone}
            </a>
          </div>
        </div>
      </header>

      {(() => {
        // порядок секций настраивает владелец (settings.sectionsOrder);
        // недостающие ключи догоняют в конце — секция не потеряется никогда
        const order: SectionKey[] = [...new Set([...(s.sectionsOrder ?? []), ...DEFAULT_SECTION_ORDER])]

        const secAbout = s.description ? (
          <Section>
            <div className="overline" style={{ textAlign: 'center' }}>О нас</div>
            <p style={{ maxWidth: '62ch', marginInline: 'auto', fontSize: '1.05rem' }}>{s.description}</p>
          </Section>
        ) : null

        const team = bundle.specialists.filter((x) => x.active && x.showOnTeam !== false)
        const style = s.teamCardStyle ?? 'card'
        const secTeam = s.teamEnabled && team.length > 0 ? (
          <Section>
            <div className="overline">Команда</div>
            <h2>Кто будет с вами</h2>
            <div className={`team-grid team-${style}`}>
              {team.map((sp) => (
                <div className="card team-card" key={sp.id}>
                  <div className={`sp-photo ${style === 'photo' ? 'rect' : ''}`}>
                    {sp.photoUrl ? (
                      <img src={sp.photoUrl} alt={sp.name} loading="lazy" decoding="async" />
                    ) : (
                      <span className="avatar-fallback">
                        {sp.name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="team-card-info">
                    <b>{sp.name}</b>
                    {sp.title && <div className="small muted">{sp.title}</div>}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        ) : null

        const secWorks = bundle.portfolio.length > 0 ? (
          <Section>
            <div className="overline">Портфолио</div>
            <h2>Работы</h2>
            <div className="strip">
              {bundle.portfolio.slice(0, 10).map((p) => (
                <figure key={p.id} className="strip-item">
                  <img src={p.src} alt={p.caption || p.category} loading="lazy" decoding="async" />
                  <figcaption>{p.caption || p.category}</figcaption>
                </figure>
              ))}
            </div>
            <Link to="works" className="btn" style={{ marginTop: 16 }}>Смотреть все работы</Link>
          </Section>
        ) : null

        const shootServices = bundle.services
          .filter((x) => x.kind === 'shoot')
          .sort((a, b) => a.sort - b.sort)
          .slice(0, 4)
        const rentalServices = bundle.services
          .filter((x) => x.kind === 'rental')
          .sort((a, b) => a.sort - b.sort)
        const activeHalls = bundle.halls.filter((h) => h.active)
        const serviceCardSize = s.serviceCardSize ?? 'normal'
        const hallCardSize = s.hallCardSize ?? 'normal'
        const hasShootServices = s.modes.shoots && shootServices.length > 0
        const hasRentalServices = s.modes.rental && rentalServices.length > 0
        const hasServicesBlock = hasShootServices || hasRentalServices
        // аренда — карточки залов; услуга аренды видна в блоке услуг и ведёт в форму
        const hasHallsBlock = s.modes.rental && activeHalls.length > 0
        const servicesTitle = hasShootServices
          ? hasRentalServices ? 'Услуги и аренда' : 'Пакеты съёмки'
          : 'Услуги аренды'
        const secServices = hasServicesBlock || hasHallsBlock ? (
          <Section>
            {hasServicesBlock && (
              <>
                <div className="overline">Услуги</div>
                <h2>{servicesTitle}</h2>
                <div className={`service-grid service-grid-${serviceCardSize}`}>
                  {hasShootServices && shootServices.map((svc) => {
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
                      <p className="small" style={{ marginBottom: 10 }}>
                        {svc.deliverableText}
                        {svc.deadlineDays ? ` · сдача за ${svc.deadlineDays} дн.` : ''}
                      </p>
                      {(svc.needsHall || svc.kind === 'rental') && svcHalls.length > 0 && (
                        <p className="small muted" style={{ marginBottom: 10 }}>
                          {svc.priceType === 'hourly'
                            ? `+ зал по тарифу — от ${money(Math.min(...svcHalls.map((h) => h.rates.weekday.day)))}/час`
                            : 'Зал включён в стоимость.'}
                        </p>
                      )}
                      <Link to={`book?service=${svc.id}`} className="btn btn-primary">Записаться</Link>
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
                        to={`book?mode=rental&service=${svc.id}`}
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
                        <p className="small muted" style={{ marginBottom: 10 }}>
                          {svc.needsSpecialist ? 'Со специалистом · ' : ''}зал выбирается при записи
                        </p>
                        <span className="btn btn-primary">Забронировать</span>
                      </Link>
                    )
                  })}
                </div>
              </>
            )}
            {hasHallsBlock && (
              <div style={{ marginTop: hasServicesBlock ? 28 : 0 }}>
                <div className="overline">Аренда</div>
                <h2 style={{ marginBottom: 12 }}>Аренда зала</h2>
                <div className={`hall-grid hall-grid-${hallCardSize}`}>
                  {activeHalls.map((h) => {
                    const options = rentalServicesForHall(bundle.services, h, s.modes.rental)
                    const photos = h.photos?.slice(0, 2) ?? []
                    return (
                      <div
                        key={h.id}
                        className="card hall-tile"
                        role="button"
                        tabIndex={0}
                        onClick={() => setHallModal(h)}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setHallModal(h)}
                      >
                        {photos.length > 0 && (
                          <div className={`hall-card-photos${photos.length === 1 ? ' single' : ''}`}>
                            {photos.map((src) => (
                              <img key={src} src={src} alt={h.name} loading="lazy" decoding="async" />
                            ))}
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                          <h3 style={{ marginBottom: 2 }}>{h.name}</h3>
                          <strong className="small" style={{ whiteSpace: 'nowrap' }}>
                            до {h.capacity} человек
                          </strong>
                        </div>
                        <table className="hours-table small" style={{ marginTop: 8 }}>
                          <tbody>
                            <tr><td>Будни, день</td><td>{money(h.rates.weekday.day)}/час</td></tr>
                            <tr><td>Будни, вечер</td><td>{money(h.rates.weekday.evening)}/час</td></tr>
                            <tr><td>Выходные, день</td><td>{money(h.rates.weekend.day)}/час</td></tr>
                            <tr><td>Выходные, вечер</td><td>{money(h.rates.weekend.evening)}/час</td></tr>
                          </tbody>
                        </table>
                        {options.length === 0 ? (
                          <p className="small muted" style={{ margin: '6px 0 0' }}>Бронь пока недоступна</p>
                        ) : options.length === 1 ? (
                          <Link
                            to={`book?mode=rental&service=${options[0].id}&hall=${h.id}`}
                            className="btn btn-sm btn-primary"
                            style={{ marginTop: 10 }}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            Арендовать зал
                          </Link>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            style={{ marginTop: 10 }}
                            onClick={(e) => {
                              e.stopPropagation()
                              setHallModal(h)
                            }}
                          >
                            Арендовать зал
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
                <p className="small muted" style={{ marginTop: 14 }}>
                  Все фото и тарифы — <Link to="services">условия аренды</Link>.
                </p>
              </div>
            )}
          </Section>
        ) : null

        const secInfo = s.infoCards.length > 0 ? (
          <Section>
            <div className="grid grid-3">
              {s.infoCards.map((c) => (
                <div className="card" key={c.title}>
                  <h3>{c.title}</h3>
                  <p className="muted small" style={{ margin: 0 }}>{c.text}</p>
                </div>
              ))}
            </div>
          </Section>
        ) : null

        const secReviews = s.reviewsEnabled && s.reviews.length > 0 ? (
          <Section>
            <div className="overline">Отзывы</div>
            {s.status === 'demo' && <p className="small muted">Примеры отзывов — замените на реальные.</p>}
            <div className="grid grid-3">
              {s.reviews.map((r, i) => (
                <div className="card" key={i}>
                  <strong>{r.author}</strong>{' '}
                  <span className="muted small">{'★'.repeat(r.rating)}</span>
                  <p className="small" style={{ margin: '8px 0 0' }}>{r.text}</p>
                </div>
              ))}
            </div>
          </Section>
        ) : null

        const secContacts = (
          <Section id="contacts">
            <div className="grid grid-2">
              <div className="card">
                <div className="overline">Контакты</div>
                <h3>Как найти</h3>
                <p>
                  {s.city}, <a href={s.mapsUrl} target="_blank" rel="noopener noreferrer">{s.address}</a>
                </p>
                <p>
                  <a href={`tel:${s.phone.replace(/[^+\d]/g, '')}`} style={{ fontWeight: 700 }}>{s.phone}</a>
                </p>
                <div className="chips">
                  {s.contactMethods.map((m) => (
                    <a key={m.type} className="chip" href={contactHref(m.type, m.value)} target="_blank" rel="noopener noreferrer">
                      {CONTACT_LABELS[m.type] ?? m.type}
                    </a>
                  ))}
                </div>
              </div>
              <div className="card">
                <div className="overline">Часы работы</div>
                <table className="hours-table">
                  <tbody>
                    {scheduleRows(s.schedule).map((r) => (
                      <tr key={r.key}>
                        <td>{r.label}</td>
                        <td>{r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="small muted" style={{ marginBottom: 0, marginTop: 10 }}>
                  Часовой пояс: {s.tz}. Ближайшую свободную дату подскажет {<Link to="book">форма записи</Link>}.
                </p>
              </div>
            </div>
          </Section>
        )

        const sections: Record<SectionKey, React.ReactNode> = {
          about: secAbout,
          team: secTeam,
          works: secWorks,
          services: secServices,
          info: secInfo,
          reviews: secReviews,
          contacts: secContacts,
        }
        // B-45: каждой секции нужен key — без него React ругается в консоль
        return <>{order.map((k) => <Fragment key={k}>{sections[k]}</Fragment>)}</>
      })()}
      {hallModal && (
        <HallModal
          hall={hallModal}
          slug={s.slug}
          services={rentalServicesForHall(bundle.services, hallModal, s.modes.rental)}
          onClose={() => setHallModal(null)}
        />
      )}
    </>
  )
}
