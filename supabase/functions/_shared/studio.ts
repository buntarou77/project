import { supabaseAdmin } from './supabaseAdmin.ts'
import type { TenantSettings, Specialist, Hall, Service, Addon } from './core/types.ts'

export interface StudioData {
  id: string
  settings: TenantSettings
  calendarToken: string
  specialists: Specialist[]
  halls: Hall[]
  services: Service[]
  addons: Addon[]
}

export async function loadStudioData(slug: string): Promise<StudioData | null> {
  const sb = supabaseAdmin()
  const { data: studio } = await sb.from('studios').select('id, settings, "calendarToken"').eq('slug', slug).single()
  if (!studio) return null
  const [specialists, halls, services, addons] = await Promise.all([
    sb.from('specialists').select('*').eq('studioId', studio.id),
    sb.from('halls').select('*').eq('studioId', studio.id),
    sb.from('services').select('*').eq('studioId', studio.id),
    sb.from('addons').select('*').eq('studioId', studio.id),
  ])
  return {
    id: studio.id,
    settings: studio.settings as TenantSettings,
    calendarToken: studio.calendarToken as string,
    specialists: (specialists.data ?? []) as Specialist[],
    halls: (halls.data ?? []) as Hall[],
    services: (services.data ?? []) as Service[],
    addons: (addons.data ?? []) as Addon[],
  }
}
