import type { Hall, PortfolioItem, ServiceKind, Specialist, TenantSettings } from '@/core/types'
import type { PriceBreakdown } from '@/core/price'

export type BookingStatus =
  | 'new'
  | 'confirmed'
  | 'prepaid'
  | 'shot_done'
  | 'processing'
  | 'delivered'
  | 'completed'
  | 'cancelled_by_client'
  | 'rejected'
  | 'no_show'

export const BOOKING_STATUSES: BookingStatus[] = [
  'new',
  'confirmed',
  'prepaid',
  'shot_done',
  'processing',
  'delivered',
  'completed',
  'cancelled_by_client',
  'rejected',
  'no_show',
]

export const STATUS_LABELS: Record<BookingStatus, string> = {
  new: 'Новая',
  confirmed: 'Подтверждена',
  prepaid: 'Предоплата получена',
  shot_done: 'Съёмка проведена',
  processing: 'В обработке',
  delivered: 'Сдана',
  completed: 'Завершена',
  cancelled_by_client: 'Отменена клиентом',
  rejected: 'Отклонена',
  no_show: 'Клиент не пришёл',
}

export const STATUS_ACTIVE: BookingStatus[] = ['new', 'confirmed', 'prepaid', 'shot_done', 'processing', 'delivered']

export interface BookingRecord {
  id: string
  slug: string
  kind: ServiceKind
  serviceId: string
  serviceName: string
  specialistId: string | null
  hallId: string | null
  startsAtMs: number
  endsAtMs: number
  allDay: boolean
  dayCount: number
  status: BookingStatus
  client: {
    name: string
    phone: string
    method: string
    people?: number
    notes?: string
    referenceCount?: number
  }
  price: PriceBreakdown
  paidTotal: number
  deliverablesUrl?: string
  token: string
  createdAtMs: number
  source: 'web' | 'manual'
  offsite: boolean
  travelZoneId?: string | null
  consent: { version: string; atMs: number }
}

export interface StudioBundle {
  settings: TenantSettings
  specialists: Specialist[]
  halls: Hall[]
  services: import('@/core/types').Service[]
  addons: import('@/core/types').Addon[]
  portfolio: PortfolioItem[]
}

export interface AvailabilityQuery {
  slug: string
  serviceId: string
  dateFrom: string
  dayCount?: number
  durationMin?: number
  specialistId: string | null
  hallId: string | null
  offsite: boolean
  travelZoneId: string | null
  peopleCount?: number
}

export interface BookingFilters {
  status?: BookingStatus | 'active' | 'all'
  specialistId?: string | null
  hallId?: string | null
  dateFrom?: string
  dateTo?: string
}

export interface Backend {
  kind: 'demo' | 'supabase'
  loadStudio(slug: string): Promise<StudioBundle>
  getAvailability(q: AvailabilityQuery): Promise<{ startMs: number; specialistId: string | null }[]>
  createBooking(
    payload: import('@/core/schema').CreateBookingPayload
  ): Promise<{ ok: true; token: string } | { ok: false; error: string }>
  getMyBooking(slug: string, token: string): Promise<BookingRecord | null>
  cancelMyBooking(slug: string, token: string): Promise<{ ok: boolean; error?: string }>
  requestAssistant(slug: string, message: string, kind: 'client' | 'owner'): Promise<{ reply: string; unavailable?: boolean }>
  ownerSignIn(email: string, password: string): Promise<void>
  ownerSignOut(): Promise<void>
  ownerOnAuthChange(cb: (signedIn: boolean) => void): void
  ownerBookings(slug: string, filters?: BookingFilters): Promise<BookingRecord[]>
  ownerUpdateBooking(slug: string, id: string, patch: Partial<Pick<BookingRecord, 'status' | 'paidTotal' | 'deliverablesUrl' | 'startsAtMs' | 'endsAtMs'>>): Promise<void>
  ownerCreateBookingManual(slug: string, record: Omit<BookingRecord, 'id' | 'token' | 'createdAtMs'>): Promise<void>
  ownerSaveSettings(slug: string, settings: TenantSettings): Promise<void>
  ownerUpsertSpecialist(slug: string, item: StudioBundle['specialists'][number]): Promise<void>
  ownerUpsertHall(slug: string, item: StudioBundle['halls'][number]): Promise<void>
  ownerUpsertService(slug: string, item: StudioBundle['services'][number]): Promise<void>
  ownerDeleteService(slug: string, id: string): Promise<void>
  ownerUpsertAddon(slug: string, item: StudioBundle['addons'][number]): Promise<void>
  ownerDeleteAddon(slug: string, id: string): Promise<void>
  ownerAnonymizeClient(slug: string, bookingId: string): Promise<void>
  ownerUploadPortfolioPhoto(slug: string, file: File): Promise<{ src: string; srcset?: string }>
  ownerUpsertPortfolioItem(slug: string, item: PortfolioItem): Promise<void>
  ownerDeletePortfolioItem(slug: string, id: string): Promise<void>
  ownerCalendarToken(slug: string): Promise<string | null>
}
