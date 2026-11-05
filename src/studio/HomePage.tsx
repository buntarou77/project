import { Link } from 'react-router-dom'
import type { StudioBundle } from '@/backend/types'
import { Section } from '@/ui/common'
import { humanDate, money, scheduleRows } from '@/ui/format'
import { contactHref, CONTACT_LABELS } from '@/lib/links'

export default function HomePage({ bundle }: { bundle: StudioBundle }) {
  const { settings: s } = bundle
  const hero = bundle.portfolio.find((p) => p.category === 'интерьер студии') ?? bundle.portfolio[0]

  return (
    <>
      <header className="hero">
        <div className="hero-media">
          {hero ? (
            <img src={hero.src} alt="" loading="eager" decoding="async" />
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

      {s.description && (
        <Section>
          <div className="overline">О нас</div>
          <p style={{ maxWidth: '62ch', fontSize: '1.05rem' }}>{s.description}</p>
        </Section>
      )}

      {bundle.portfolio.length > 0 && (
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
      )}

      {s.modes.shoots && bundle.services.some((x) => x.kind === 'shoot') && (
        <Section>
          <div className="overline">Услуги</div>
          <h2>Пакеты съёмки</h2>
          <div className="grid grid-2">
            {bundle.services.filter((x) => x.kind === 'shoot').sort((a, b) => a.sort - b.sort).slice(0, 4).map((svc) => (
              <div className="card" key={svc.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                  <h3 style={{ marginBottom: 2 }}>{svc.name}</h3>
                  <strong style={{ whiteSpace: 'nowrap' }}>{svc.priceType === 'fixed' ? money(svc.price) : 'почасово'}</strong>
                </div>
                <p className="muted small">{svc.description}</p>
                <p className="small" style={{ marginBottom: 10 }}>
                  {svc.deliverableText}
                  {svc.deadlineDays ? ` · сдача за ${svc.deadlineDays} дн.` : ''}
                </p>
                <Link to={`book?service=${svc.id}`} className="btn btn-primary">Записаться</Link>
              </div>
            ))}
          </div>
          {s.modes.rental && bundle.halls.length > 0 && (
            <p className="small muted" style={{ marginTop: 14 }}>
              Есть аренда залов от {money(Math.min(...bundle.halls.map((h) => h.rates.weekday.day)))}/час —{' '}
              <Link to="services">условия аренды</Link>.
            </p>
          )}
        </Section>
      )}

      {s.infoCards.length > 0 && (
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
      )}

      {s.reviewsEnabled && s.reviews.length > 0 && (
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
      )}

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
    </>
  )
}
