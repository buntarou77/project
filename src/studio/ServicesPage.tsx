import { Link } from 'react-router-dom'
import type { StudioBundle } from '@/backend/types'
import { Section } from '@/ui/common'
import { money, hoursLabel } from '@/ui/format'

export default function ServicesPage({ bundle }: { bundle: StudioBundle }) {
  const { settings: s } = bundle
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
              <div className="card" key={hall.id}>
                <h3 style={{ marginBottom: 2 }}>{hall.name}</h3>
                <p className="muted small">до {hall.capacity} человек</p>
                <table className="hours-table small">
                  <tbody>
                    <tr><td>Будни, день</td><td>{money(hall.rates.weekday.day)}/час</td></tr>
                    <tr><td>Будни, вечер (от {s.eveningFrom})</td><td>{money(hall.rates.weekday.evening)}/час</td></tr>
                    <tr><td>Выходные, день</td><td>{money(hall.rates.weekend.day)}/час</td></tr>
                    <tr><td>Выходные, вечер</td><td>{money(hall.rates.weekend.evening)}/час</td></tr>
                  </tbody>
                </table>
                <Link to={`/s/${s.slug}/book?mode=rental&hall=${hall.id}`} className="btn btn-primary btn-block" style={{ marginTop: 14 }}>
                  Забронировать зал
                </Link>
              </div>
            ))}
          </div>
          {bundle.addons.filter((a) => a.appliesTo !== 'shoot').length > 0 && (
            <p className="small muted">
              Дополнительно: {bundle.addons.filter((a) => a.appliesTo !== 'shoot').map((a) => `${a.name} (+${money(a.price)}${a.unit === 'hour' ? '/час' : ''})`).join(', ')}
            </p>
          )}
        </Section>
      )}

      <Section>
        <div className="card">
          <div className="overline">Условия</div>
          <h3 style={{ marginBottom: 8 }}>Правила отмены</h3>
          <p className="small" style={{ marginBottom: 0 }}>{s.cancellation.text}</p>
        </div>
      </Section>
    </>
  )
}
