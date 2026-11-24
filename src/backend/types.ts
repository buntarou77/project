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
  // команда услуги: все участники, а specialistId — первый (совместимость)
  specialistIds?: string[]
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

// reason — человеческое объяснение, почему слотов нет («Выберите зал» и т.п.)
export interface AvailabilityResponse {
  slots: { startMs: number; specialistId: string | null; specialistIds?: string[] }[]
  reason?: string
}

export interface BookingFilters {
  status?: BookingStatus | 'active' | 'all'
  specialistId?: string | null
  hallId?: string | null
  dateFrom?: string
  dateTo?: string
}

export interface TeamMember {
  userId: string
  email: string
  role: 'owner' | 'manager' | 'employee'
  createdAtMs?: number
}

export interface TeamInvitation {
  id: string
  email: string | null
  role: 'owner' | 'manager' | 'employee'
  expiresAtMs: number
  acceptedAtMs: number | null
}

// Активная заявка, пересекающая создаваемый закрытый период (отпуск/закрытие)
export interface ClosedPeriodConflict {
  id: string
  serviceName: string
  clientName: string
  startsAtMs: number
}

export interface Backend {
  kind: 'demo' | 'supabase' | 'express'
  loadStudio(slug: string): Promise<StudioBundle>
  getAvailability(q: AvailabilityQuery): Promise<AvailabilityResponse>
  createBooking(
    payload: import('@/core/schema').CreateBookingPayload
  ): Promise<{ ok: true; token: string; price?: PriceBreakdown } | { ok: false; error: string }>
  getMyBooking(slug: string, token: string): Promise<BookingRecord | null>
  cancelMyBooking(slug: string, token: string): Promise<{ ok: boolean; error?: string }>
  requestAssistant(slug: string, message: string, kind: 'client' | 'owner'): Promise<{ reply: string; unavailable?: boolean }>
  // Push-уведомления витрины (напоминания о записи). Опциональны: демо-адаптер
  // их не реализует — фича в демо просто не показывается.
  pushKey?(slug: string): Promise<{ publicKey: string | null }>
  pushSubscribe?(slug: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }, token: string): Promise<void>
  pushUnsubscribe?(slug: string, endpoint: string): Promise<void>
  ownerSignIn(email: string, password: string): Promise<void>
  ownerSignOut(): Promise<void>
  ownerOnAuthChange(cb: (signedIn: boolean) => void): void
  ownerBookings(slug: string, filters?: BookingFilters): Promise<BookingRecord[]>
  ownerUpdateBooking(slug: string, id: string, patch: Partial<Pick<BookingRecord, 'status' | 'paidTotal' | 'deliverablesUrl' | 'startsAtMs' | 'endsAtMs'>>): Promise<void>
  ownerCreateBookingManual(slug: string, record: Omit<BookingRecord, 'id' | 'token' | 'createdAtMs'>): Promise<void>
  ownerSaveSettings(slug: string, settings: TenantSettings): Promise<void>
  ownerUpsertSpecialist(slug: string, item: StudioBundle['specialists'][number]): Promise<void>
  ownerDeleteSpecialist?(slug: string, id: string): Promise<void>
  ownerUploadSpecialistPhoto?(slug: string, file: File): Promise<{ src: string }>
  ownerUpsertHall(slug: string, item: StudioBundle['halls'][number]): Promise<void>
  ownerDeleteHall?(slug: string, id: string): Promise<void>
  ownerUploadHallPhoto?(slug: string, file: File): Promise<{ src: string }>
  ownerUpsertService(slug: string, item: StudioBundle['services'][number]): Promise<void>
  ownerDeleteService(slug: string, id: string): Promise<void>
  ownerUpsertAddon(slug: string, item: StudioBundle['addons'][number]): Promise<void>
  ownerDeleteAddon(slug: string, id: string): Promise<void>
  ownerAnonymizeClient(slug: string, bookingId: string): Promise<void>
  ownerBookingReferences?(slug: string, bookingId: string): Promise<{ id: string; url: string; sort: number }[]>
  // Y3: загрузка референсов после создания брони (multipart); токен — секрет брони
  uploadBookingReferences?(slug: string, token: string, files: File[]): Promise<{ count: number }>
  ownerUploadPortfolioPhoto(slug: string, file: File): Promise<{ src: string; srcset?: string }>
  ownerUpsertPortfolioItem(slug: string, item: PortfolioItem): Promise<void>
  ownerDeletePortfolioItem(slug: string, id: string): Promise<void>
  ownerCalendarToken(slug: string): Promise<string | null>
  ownerStudios?(): Promise<{ id: string; slug: string; name: string; role: string }[]>
  ownerTeamList?(slug: string): Promise<{ members: TeamMember[]; invitations: TeamInvitation[] }>
  ownerTeamInvite?(slug: string, email: string, role: 'manager' | 'employee'): Promise<void>
  ownerTeamRevokeInvitation?(slug: string, invitationId: string): Promise<void>
  ownerTeamRemoveMember?(slug: string, userId: string): Promise<void>
  ownerClosedPeriods?(slug: string): Promise<import('@/core/types').ClosedPeriod[]>
  // активные заявки, пересекающие новый период (предупреждение владельцу)
  ownerUpsertClosedPeriod?(
    slug: string,
    item: import('@/core/types').ClosedPeriod
  ): Promise<{ conflicts?: ClosedPeriodConflict[] }>
  ownerDeleteClosedPeriod?(slug: string, id: string): Promise<void>
  ownerUploadServicePhoto?(slug: string, file: File): Promise<{ src: string }>
  // своё фото фона шапки (не из портфолио): сжимается на устройстве, адаптер
  // возвращает URL/dataURL — его caller кладёт в settings.heroPhotoUrl через ownerSaveSettings
  ownerUploadHeroPhoto?(slug: string, file: File): Promise<{ src: string }>
}
