import { supabaseAdmin } from './supabaseAdmin.ts'
import type { StudioData } from './studio.ts'
import type { BusyInterval } from './core/time.ts'
import { utcToZonedDate } from './core/time.ts'

const ACTIVE = ['new', 'confirmed', 'prepaid', 'shot_done', 'processing', 'delivered']

export interface BusyData {
  busy: BusyInterval[]
  dayLimitBookings: { date: string; specialistId: string }[]
  fullDayBusy: { date: string; resourceType: 'specialist' | 'hall'; resourceId: string }[]
}

function parseRange(during: string): { startMs: number; endMs: number } | null {
  const m = during.match(/\[(.*),(.*)\)/)
  if (!m) return null
  return { startMs: new Date(m[1]).getTime(), endMs: new Date(m[2]).getTime() }
}

// Единая загрузка занятости: брони с буферами, закрытые периоды, отпуска,
// лимиты дня и полнодневные блокировки. Используется availability и помощником.
export async function loadBusy(studio: StudioData): Promise<BusyData> {
  const sb = supabaseAdmin()
  const out: BusyData = { busy: [], dayLimitBookings: [], fullDayBusy: [] }

  const { data: resRows } = await sb
    .from('booking_resources')
    .select('"resourceType", "resourceId", "during"')
    .eq('studioId', studio.id)
  for (const row of (resRows ?? []) as { resourceType: string; resourceId: string; during: string }[]) {
    const r = parseRange(row.during)
    if (r) out.busy.push({ resourceType: row.resourceType as 'specialist' | 'hall', resourceId: row.resourceId, ...r })
  }

  const { data: closedRows } = await sb
    .from('closed_periods')
    .select('"resourceType", "resourceId", "during"')
    .eq('studioId', studio.id)
  for (const row of (closedRows ?? []) as { resourceType: string | null; resourceId: string | null; during: string }[]) {
    const r = parseRange(row.during)
    if (!r) continue
    if (row.resourceType && row.resourceId) {
      out.busy.push({ resourceType: row.resourceType as 'specialist' | 'hall', resourceId: row.resourceId, ...r })
    } else {
      for (const s of studio.specialists) out.busy.push({ resourceType: 'specialist', resourceId: s.id, ...r })
      for (const h of studio.halls) out.busy.push({ resourceType: 'hall', resourceId: h.id, ...r })
    }
  }

  const { data: activeBookings } = await sb
    .from('bookings')
    .select('"specialistId", "hallId", "startsAt", "allDay"')
    .eq('studioId', studio.id)
    .in('status', ACTIVE)
  for (const b of (activeBookings ?? []) as { specialistId: string | null; hallId: string | null; startsAt: string; allDay: boolean }[]) {
    const date = utcToZonedDate(studio.settings.tz, new Date(b.startsAt).getTime())
    if (b.specialistId) out.dayLimitBookings.push({ date, specialistId: b.specialistId })
    if (b.allDay && b.specialistId) out.fullDayBusy.push({ date, resourceType: 'specialist', resourceId: b.specialistId })
    if (b.allDay && b.hallId) out.fullDayBusy.push({ date, resourceType: 'hall', resourceId: b.hallId })
  }

  return out
}
