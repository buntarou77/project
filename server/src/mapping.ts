import type { BookingRecord, BookingStatus, StudioBundle } from '../../src/backend/types'
import type { Addon, Hall, PortfolioItem, Service, Specialist, TenantSettings } from '../../src/core/types'

// snake_case (БД) → camelCase (домен/API). Единственное место маппинга (принцип §2.4).

export function mapSpecialist(row: Record<string, unknown>): Specialist {
  return {
    id: row.id as string,
    name: row.name as string,
    title: (row.title as string) ?? '',
    active: Boolean(row.active),
    dayLimit: (row.day_limit as number) ?? 1,
    photoUrl: (row.photo_url as string) ?? undefined,
    showOnTeam: (row.show_on_team as boolean) ?? undefined,
    schedule: (row.schedule as Specialist['schedule']) ?? undefined,
    hourRate: (row.hour_rate as number) ?? undefined,
  }
}

export function mapHall(row: Record<string, unknown>): Hall {
  return {
    id: row.id as string,
    name: row.name as string,
    capacity: (row.capacity as number) ?? 5,
    rates: row.rates as Hall['rates'],
    active: Boolean(row.active),
    photos: (row.photos as string[]) ?? [],
  }
}

export function mapService(row: Record<string, unknown>): Service {
  return {
    id: row.id as string,
    kind: row.kind as Service['kind'],
    name: row.name as string,
    description: (row.description as string) ?? '',
    priceType: row.price_type as Service['priceType'],
    price: (row.price as number) ?? 0,
    durationMin: (row.duration_min as number) ?? 60,
    includes: (row.includes as string[]) ?? [],
    deliverableText: (row.deliverable_text as string) ?? '',
    deadlineDays: (row.deadline_days as number) ?? 7,
    prepayment: row.prepayment as Service['prepayment'],
    needsSpecialist: Boolean(row.needs_specialist),
    needsHall: Boolean(row.needs_hall),
    defaultHallId: (row.default_hall_id as string) ?? undefined,
    hallIds: (row.hall_ids as string[]) ?? undefined,
    specialistIds: (row.specialist_ids as string[]) ?? undefined,
    addonIds: (row.addon_ids as string[]) ?? undefined,
    maxPeople: (row.max_people as number) ?? undefined,
    photoUrl: (row.photo_url as string) ?? undefined,
    fullDay: Boolean(row.full_day),
    multiDayMax: (row.multi_day_max as number) ?? 1,
    autoConfirm: Boolean(row.auto_confirm),
    setupMin: (row.setup_min as number) ?? 0,
    cleanupMin: (row.cleanup_min as number) ?? 0,
    sort: (row.sort as number) ?? 0,
  }
}

export function mapAddon(row: Record<string, unknown>): Addon {
  return {
    id: row.id as string,
    appliesTo: row.applies_to as Addon['appliesTo'],
    name: row.name as string,
    price: (row.price as number) ?? 0,
    unit: row.unit as Addon['unit'],
  }
}

export function mapPortfolio(row: Record<string, unknown>): PortfolioItem {
  return {
    id: row.id as string,
    category: (row.category as string) ?? '',
    caption: (row.caption as string) ?? '',
    kind: (row.kind as PortfolioItem['kind']) ?? 'image',
    videoUrl: (row.video_url as string) ?? undefined,
    src: row.src as string,
    srcset: (row.srcset as string) ?? undefined,
    sort: (row.sort as number) ?? 0,
  }
}

export function mapStudio(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    slug: row.slug as string,
    settings: row.settings as TenantSettings,
    status: row.status as 'demo' | 'active',
    calendarToken: row.calendar_token as string,
  }
}

const ms = (v: unknown) => new Date(v as string).getTime()

export function mapBooking(row: Record<string, unknown>, slug: string): BookingRecord {
  return {
    id: row.id as string,
    slug,
    kind: row.kind as BookingRecord['kind'],
    serviceId: (row.service_id as string) ?? '',
    serviceName: (row.service_name as string) ?? '',
    specialistId: (row.specialist_id as string) ?? null,
    hallId: (row.hall_id as string) ?? null,
    startsAtMs: ms(row.starts_at),
    endsAtMs: ms(row.ends_at),
    allDay: Boolean(row.all_day),
    dayCount: (row.day_count as number) ?? 1,
    status: row.status as BookingStatus,
    client: row.client as BookingRecord['client'],
    price: row.price as BookingRecord['price'],
    paidTotal: Number(row.paid_total ?? 0),
    deliverablesUrl: (row.deliverables_url as string) ?? undefined,
    token: '',
    createdAtMs: ms(row.created_at),
    source: (row.source as BookingRecord['source']) ?? 'web',
    offsite: Boolean(row.offsite),
    travelZoneId: (row.travel_zone_id as string) ?? null,
    consent: (row.consent as BookingRecord['consent']) ?? { version: '', atMs: 0 },
  }
}

// Пути из tenant.json относительные (photos/…): на витрине их надо разрезать
// в абсолютные /tenants/<slug>/… — статику отдаёт фронт из public/ (та же
// логика, что в src/backend/demo.ts).
function absAssetUrl(slug: string, src: string): string {
  return /^(https?:|data:|\/)/.test(src) ? src : `/tenants/${slug}/${src.replace(/^\.?\//, '')}`
}

export function buildBundle(
  studio: ReturnType<typeof mapStudio>,
  specialists: Specialist[],
  halls: Hall[],
  services: Service[],
  addons: Addon[],
  portfolio: PortfolioItem[]
): StudioBundle {
  return {
    settings: studio.settings as StudioBundle['settings'],
    specialists,
    halls: halls.map((h) => ({ ...h, photos: (h.photos ?? []).map((src) => absAssetUrl(studio.slug, src)) })),
    services,
    addons,
    portfolio: portfolio.map((p) => ({ ...p, src: absAssetUrl(studio.slug, p.src) })),
  }
}
