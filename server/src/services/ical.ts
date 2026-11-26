import { query } from '../db'
import { sha256Hex } from './tokens'

function esc(s: string): string {
  return s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

// B-46г: RFC5545 — физическая строка ≤75 октетов UTF-8, продолжение начинается
// с пробела (он входит в лимит). Считаем байты и режем по границам символов,
// иначе многобайтовый символ разрывался между строками.
function fold(line: string): string {
  const LIMIT = 75
  if (Buffer.byteLength(line, 'utf8') <= LIMIT) return line
  const parts: string[] = []
  let cur = ''
  let bytes = 0
  let limit = LIMIT
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8')
    if (bytes + b > limit) {
      parts.push(cur)
      cur = ''
      bytes = 0
      limit = LIMIT - 1 // место под ведущий пробел продолжения
    }
    cur += ch
    bytes += b
  }
  parts.push(cur)
  return parts.map((p, i) => (i === 0 ? p : ' ' + p)).join('\r\n')
}

function foldLines(lines: string[]): string {
  return lines.map(fold).join('\r\n')
}

function event(b: { id: string; service_name: string; status: string; starts_at: Date; ends_at: Date }, studioName: string): string {
  const startMs = new Date(b.starts_at).getTime()
  const endMs = new Date(b.ends_at).getTime()
  const cancelled = ['cancelled_by_client', 'rejected', 'no_show'].includes(b.status)
  return foldLines([
    'BEGIN:VEVENT',
    `UID:${b.id}@booking`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(startMs)}`,
    `DTEND:${stamp(endMs)}`,
    `SUMMARY:${esc(`${b.service_name} — ${studioName}`)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
  ])
}

function calendar(events: string, name: string): string {
  // events уже свёрнут построчно; пустая лента не должна давать пустую строку
  // внутри VCALENDAR (fold строк ≤75 октетов — no-op)
  const body = events ? events.split('\r\n') : []
  return foldLines([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//photo-booking-platform//RU',
    `X-WR-CALNAME:${esc(name)}`,
    ...body,
    'END:VCALENDAR',
  ])
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
