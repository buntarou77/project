import { query } from '../db'
import { sha256Hex } from './tokens'

function esc(s: string): string {
  return s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function event(b: { id: string; service_name: string; status: string; starts_at: Date; ends_at: Date }, studioName: string): string {
  const startMs = new Date(b.starts_at).getTime()
  const endMs = new Date(b.ends_at).getTime()
  const cancelled = ['cancelled_by_client', 'rejected', 'no_show'].includes(b.status)
  return [
    'BEGIN:VEVENT',
    `UID:${b.id}@booking`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(startMs)}`,
    `DTEND:${stamp(endMs)}`,
    `SUMMARY:${esc(`${b.service_name} — ${studioName}`)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
  ].join('\r\n')
}

function calendar(events: string, name: string): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//photo-booking-platform//RU\r\nX-WR-CALNAME:${esc(name)}\r\n${events}\r\nEND:VCALENDAR`
}

// Токен = calendar_token студии (лента, только чтение) или access_token заявки (одно событие).
export async function icsForToken(slug: string, token: string): Promise<string | null> {
  const studio = await query<{ id: string; calendar_token: string; settings: { name: string } }>(
    `select id, calendar_token, settings from studios where slug = $1`,
    [slug]
  )
  if (studio.rows.length === 0) return null
  const s = studio.rows[0]
  const studioName = s.settings.name ?? slug

  if (token === s.calendar_token) {
    const rows = await query(
      `select id, service_name, status, starts_at, ends_at from bookings
       where studio_id = $1 and starts_at >= now()
         and status in ('new','confirmed','prepaid','shot_done','processing','delivered')
       order by starts_at`,
      [s.id]
    )
    return calendar(rows.rows.map((b) => event(b as never, studioName)).join('\r\n'), studioName)
  }

  const booking = await query(
    `select id, service_name, status, starts_at, ends_at from bookings
     where studio_id = $1 and access_token_hash = $2`,
    [s.id, sha256Hex(token)]
  )
  if (booking.rows.length === 0) return null
  return calendar(event(booking.rows[0] as never, studioName), studioName)
}
