import { formatInTimeZone } from 'date-fns-tz'

function icsStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export function buildIcs(opts: {
  title: string
  description?: string
  location?: string
  startMs: number
  endMs: number
}): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//photo-booking-platform//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsStamp(opts.startMs)}-${Math.random().toString(36).slice(2, 8)}@booking`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${icsStamp(opts.startMs)}`,
    `DTEND:${icsStamp(opts.endMs)}`,
    `SUMMARY:${escapeText(opts.title)}`,
    opts.description ? `DESCRIPTION:${escapeText(opts.description)}` : '',
    opts.location ? `LOCATION:${escapeText(opts.location)}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n')
}

function escapeText(s: string): string {
  return s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')
}

export function downloadIcs(filename: string, opts: Parameters<typeof buildIcs>[0]) {
  const blob = new Blob([buildIcs(opts)], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function icsFeedUrl(baseUrl: string, slug: string, token: string): string {
  return `${baseUrl}/functions/v1/ics?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`
}

export function localIcsHint(tz: string, ms: number): string {
  return formatInTimeZone(new Date(ms), tz, 'HH:mm')
}
