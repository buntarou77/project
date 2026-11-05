export type ContactType = 'telegram' | 'whatsapp' | 'vk' | 'max' | 'phone'

export interface ContactMethod {
  type: ContactType
  value: string
}

export interface WeeklyWindow {
  open: string // "10:00"
  close: string // "20:00"
}

export type WeekSchedule = Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', WeeklyWindow | null>

export interface TravelZone {
  id: string
  name: string
  minutesBefore: number
  minutesAfter: number
  extraFee: number
}

export interface InfoCard {
  icon: string
  title: string
  text: string
}

export interface Review {
  author: string
  rating: number
  text: string
}

export interface TenantSettings {
  slug: string
  name: string
  tagline: string
  description: string
  city: string
  address: string
  mapsUrl: string
  phone: string
  contactMethods: ContactMethod[]
  tz: string
  accent: string
  theme: 'light' | 'dark' | 'auto'
  modes: { shoots: boolean; rental: boolean }
  status: 'demo' | 'active'
  schedule: WeekSchedule
  closedDates: string[]
  cancellation: { freeHours: number; text: string }
  prepaymentDefault: { type: 'percent' | 'amount'; value: number }
  travelZones: TravelZone[]
  infoCards: InfoCard[]
  reviews: Review[]
  reviewsEnabled: boolean
  eveningFrom: string
}

export interface Specialist {
  id: string
  name: string
  title: string
  active: boolean
  dayLimit: number
}

export interface HallRates {
  weekday: { day: number; evening: number }
  weekend: { day: number; evening: number }
}

export interface Hall {
  id: string
  name: string
  capacity: number
  rates: HallRates
  active: boolean
}

export type ServiceKind = 'shoot' | 'rental'

export interface Service {
  id: string
  kind: ServiceKind
  name: string
  description: string
  priceType: 'fixed' | 'hourly'
  price: number
  durationMin: number
  includes: string[]
  deliverableText: string
  deadlineDays: number
  prepayment: { type: 'percent' | 'amount'; value: number }
  needsSpecialist: boolean
  needsHall: boolean
  defaultHallId?: string
  fullDay: boolean
  multiDayMax: number
  autoConfirm: boolean
  setupMin: number
  cleanupMin: number
  sort: number
}

export interface Addon {
  id: string
  appliesTo: ServiceKind | 'both'
  name: string
  price: number
  unit: 'booking' | 'hour' | 'person'
}

export interface PortfolioItem {
  id: string
  category: string
  caption: string
  kind: 'image' | 'video'
  videoUrl?: string
  src: string
  srcset?: string
  sort: number
}

export interface TenantConfig {
  settings: TenantSettings
  specialists: Specialist[]
  halls: Hall[]
  services: Service[]
  addons: Addon[]
  portfolio: PortfolioItem[]
  seedBookings: {
    startsAt: string
    endsAt: string
    specialistId?: string
    hallId?: string
    summary: string
  }[]
}

export const PORTFOLIO_CATEGORIES = [
  'портрет',
  'семейная',
  'свадьба',
  'love story',
  'бизнес и контент',
  'предметная',
  'видео',
  'интерьер студии',
] as const
