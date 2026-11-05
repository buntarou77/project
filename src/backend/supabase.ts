import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from '@/lib/env'
import type {
  AvailabilityQuery,
  Backend,
  BookingFilters,
  BookingRecord,
  StudioBundle,
} from './types'
import type { CreateBookingPayload } from '@/core/schema'
import type { TenantSettings } from '@/core/types'

let sb: SupabaseClient | null = null

function client(): SupabaseClient {
  if (!sb) sb = createClient(env.VITE_SUPABASE_URL!, env.VITE_SUPABASE_ANON_KEY!)
  return sb
}

async function fn<T>(name: string, body: unknown): Promise<T> {
  const res = await fetch(`${env.VITE_SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.VITE_SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${env.VITE_SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Ошибка сервера')
  return data as T
}

// Колонки таблиц в DDL названы в camelCase и совпадают с доменными типами,
// поэтому строки достаточно привести к типу без ручного маппинга полей.
function rows<T>(data: unknown): T[] {
  return (data as T[]) ?? []
}

async function studioId(slug: string): Promise<string> {
  const { data, error } = await client().from('studios').select('id').eq('slug', slug).single()
  if (error) throw error
  return (data as { id: string }).id
}

export const supabaseBackend: Backend = {
  kind: 'supabase',

  async loadStudio(slug): Promise<StudioBundle> {
    const c = client()
    const { data: studio, error } = await c
      .from('studios')
      .select('id, settings')
      .eq('slug', slug)
      .single()
    if (error) throw new Error('Студия не найдена')
    const sid = studio.id as string
    const [specialists, halls, services, addons, portfolio] = await Promise.all([
      c.from('specialists').select('*').eq('studioId', sid).order('name'),
      c.from('halls').select('*').eq('studioId', sid).order('name'),
      c.from('services').select('*').eq('studioId', sid).order('sort'),
      c.from('addons').select('*').eq('studioId', sid).order('sort'),
      c.from('portfolio').select('*').eq('studioId', sid).order('sort'),
    ])
    return {
      settings: studio.settings as TenantSettings,
      specialists: rows<StudioBundle['specialists'][number]>(specialists.data),
      halls: rows<StudioBundle['halls'][number]>(halls.data),
      services: rows<StudioBundle['services'][number]>(services.data),
      addons: rows<StudioBundle['addons'][number]>(addons.data),
      portfolio: rows<StudioBundle['portfolio'][number]>(portfolio.data),
    }
  },

  async getAvailability(q: AvailabilityQuery) {
    const { slots } = await fn<{ slots: { startMs: number; specialistId: string | null }[] }>('availability', q)
    return slots
  },

  async createBooking(payload: CreateBookingPayload) {
    return fn<{ ok: true; token: string } | { ok: false; error: string }>('create-booking', payload)
  },

  async getMyBooking(slug, token) {
    return fn<BookingRecord | null>('my-booking', { slug, token })
  },

  async cancelMyBooking(slug, token) {
    return fn<{ ok: boolean; error?: string }>('my-booking', { slug, token, action: 'cancel' })
  },

  async requestAssistant(slug, message, kind) {
    return fn<{ reply: string }>('assistant', { slug, message, kind })
  },

  async ownerSignIn(email, password) {
    const { error } = await client().auth.signInWithPassword({ email, password })
    if (error) throw error
  },

  async ownerSignOut() {
    await client().auth.signOut()
  },

  ownerOnAuthChange(cb) {
    client().auth.onAuthStateChange((_e, session) => cb(Boolean(session)))
  },

  async ownerBookings(slug, filters: BookingFilters = {}) {
    const c = client()
    let q = c.from('bookings').select('*').eq('slug', slug).order('startsAt')
    if (filters.status && filters.status !== 'all') {
      if (filters.status === 'active')
        q = q.in('status', ['new', 'confirmed', 'prepaid', 'shot_done', 'processing', 'delivered'])
      else q = q.eq('status', filters.status)
    }
    if (filters.specialistId) q = q.eq('specialistId', filters.specialistId)
    if (filters.hallId) q = q.eq('hallId', filters.hallId)
    if (filters.dateFrom) q = q.gte('startsAt', new Date(filters.dateFrom + 'T00:00:00Z').toISOString())
    if (filters.dateTo) q = q.lte('startsAt', new Date(filters.dateTo + 'T23:59:59Z').toISOString())
    const { data, error } = await q
    if (error) throw error
    return rows<BookingRecord>(data)
  },

  async ownerUpdateBooking(_slug, id, patch) {
    const rec: Record<string, unknown> = {}
    if (patch.status) rec.status = patch.status
    if (patch.paidTotal !== undefined) rec.paidTotal = patch.paidTotal
    if (patch.deliverablesUrl !== undefined) rec.deliverablesUrl = patch.deliverablesUrl
    if (patch.startsAtMs) rec.startsAt = new Date(patch.startsAtMs).toISOString()
    if (patch.endsAtMs) rec.endsAt = new Date(patch.endsAtMs).toISOString()
    const { error } = await client().from('bookings').update(rec).eq('id', id)
    if (error) throw error
  },

  async ownerCreateBookingManual(slug, record) {
    const { error } = await client()
      .from('bookings')
      .insert({ ...record, slug, createdAtMs: new Date().toISOString() })
    if (error) throw error
  },

  async ownerSaveSettings(slug, settings: TenantSettings) {
    const { error } = await client().from('studios').update({ settings }).eq('slug', slug)
    if (error) throw error
  },

  async ownerUpsertSpecialist(slug, item) {
    const sid = await studioId(slug)
    const { error } = await client().from('specialists').upsert({ ...item, studioId: sid })
    if (error) throw error
  },

  async ownerUpsertHall(slug, item) {
    const sid = await studioId(slug)
    const { error } = await client().from('halls').upsert({ ...item, studioId: sid })
    if (error) throw error
  },

  async ownerUpsertService(slug, item) {
    const sid = await studioId(slug)
    const { error } = await client().from('services').upsert({ ...item, studioId: sid })
    if (error) throw error
  },

  async ownerDeleteService(_slug, id) {
    const { error } = await client().from('services').delete().eq('id', id)
    if (error) throw error
  },

  async ownerUpsertAddon(slug, item) {
    const sid = await studioId(slug)
    const { error } = await client().from('addons').upsert({ ...item, studioId: sid })
    if (error) throw error
  },

  async ownerDeleteAddon(_slug, id) {
    const { error } = await client().from('addons').delete().eq('id', id)
    if (error) throw error
  },

  async ownerAnonymizeClient(_slug, bookingId) {
    const { error } = await client()
      .from('bookings')
      .update({ client: { name: 'Данные удалены', phone: 'удалено', method: 'phone' }, references: [] })
      .eq('id', bookingId)
    if (error) throw error
  },

  async ownerUploadPortfolioPhoto(slug, file) {
    const c = client()
    const sid = await studioId(slug)
    const { compressImage } = await import('@/lib/image')
    const { variants } = await compressImage(file)
    const paths: Record<number, string> = {}
    for (const w of [640, 1024, 1600]) {
      if (!variants[w]) continue
      const path = `${sid}/${Date.now()}-${w}.jpg`
      const { error } = await c.storage.from('portfolio').upload(path, variants[w], { contentType: 'image/jpeg' })
      if (error) throw error
      paths[w] = path
    }
    const publicUrl = (p: string) => c.storage.from('portfolio').getPublicUrl(p).data.publicUrl
    const src = publicUrl(paths[640])
    const srcset = paths[1024]
      ? `${publicUrl(paths[1024])} 1024w${paths[1600] ? `, ${publicUrl(paths[1600])} 1600w` : ''}`
      : undefined
    return { src, srcset }
  },

  async ownerCalendarToken(slug) {
    const { data } = await client().from('studios').select('calendarToken').eq('slug', slug).single()
    return ((data as { calendarToken?: string })?.calendarToken) ?? null
  },

  async ownerUpsertPortfolioItem(slug, item) {
    const c = client()
    const { data: studio } = await c.from('studios').select('id').eq('slug', slug).single()
    const { error } = await c.from('portfolio').upsert({ ...item, studioId: (studio as { id: string }).id })
    if (error) throw error
  },

  async ownerDeletePortfolioItem(_slug, id) {
    const { error } = await client().from('portfolio').delete().eq('id', id)
    if (error) throw error
  },
}
