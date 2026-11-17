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

export type SectionKey = 'about' | 'team' | 'works' | 'services' | 'info' | 'reviews' | 'contacts'

export const DEFAULT_SECTION_ORDER: SectionKey[] = ['about', 'team', 'works', 'services', 'info', 'reviews', 'contacts']

export const SECTION_LABELS: Record<SectionKey, string> = {
  about: 'О нас (описание)',
  team: 'Команда',
  works: 'Работы (портфолио)',
  services: 'Услуги и залы',
  info: 'Информационные карточки',
  reviews: 'Отзывы',
  contacts: 'Контакты и часы',
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
  teamEnabled: boolean
  teamCardStyle: 'card' | 'photo' | 'minimal'
  specialistChoiceVisible: boolean
  hallChoiceVisible: boolean
  eveningFrom: string
  // порядок секций витрины после hero; undefined = DEFAULT_SECTION_ORDER
  sectionsOrder?: SectionKey[]
  // фото витринного hero (id работы из портфолио); undefined = первый «интерьер студии»
  heroPhotoId?: string
}

// отпуск специалиста / закрытие зала / закрытие студии целиком
export interface ClosedPeriod {
  id: string
  resourceType: 'specialist' | 'hall' | 'studio'
  resourceId: string | null
  dateFrom: string // YYYY-MM-DD
  dateTo: string // YYYY-MM-DD
  reason: string
}

export interface Specialist {
  id: string
  name: string
  title: string
  active: boolean
  dayLimit: number
  photoUrl?: string
  // показывать в блоке «Команда» на витрине (активность брони — отдельный флаг active)
  showOnTeam?: boolean
  // свой недельный график; undefined/null — работает по графику студии
  schedule?: WeekSchedule | null
  // ставка за час работы; учитывается в почасовых услугах, null — не тарифицируется
  hourRate?: number | null
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
  // галерея зала для витрины; относительные пути tenant.json разрезаются в /tenants/<slug>/…
  photos?: string[]
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
  // белый список залов, в которых услуга доступна; пусто/undefined — любые активные залы
  hallIds?: string[]
  // специалисты, которые могут брать услугу; пусто/undefined — любой активный
  specialistIds?: string[]
  // допуслуги этой услуги (управляются в карточке услуги);
  // undefined — легаси-фолбэк: допы фильтруются по appliesTo
  addonIds?: string[]
  // максимум людей на услугу (независимо от вместимости зала); undefined — без лимита
  maxPeople?: number
  fullDay: boolean
  multiDayMax: number
  autoConfirm: boolean
  setupMin: number
  cleanupMin: number
  sort: number
  // обложка услуги на витрине (необязательна)
  photoUrl?: string
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
