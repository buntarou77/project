import fs from 'node:fs'
import path from 'node:path'
import { placeholderPhotos } from './placeholder-photos'

const slugArg = process.argv.find((a) => a.startsWith('--slug='))?.split('=')[1]
const nameArg = process.argv.find((a) => a.startsWith('--name='))?.split('=')[1]
const cityArg = process.argv.find((a) => a.startsWith('--city='))?.split('=')[1]

if (!slugArg || !/^[a-z0-9-]{2,40}$/.test(slugArg)) {
  console.error('Использование: pnpm tenant:new --slug=my-studio --name="Студия Мой" --city=Москва')
  process.exit(1)
}

const dir = path.join('tenants', slugArg)
if (fs.existsSync(dir)) {
  console.error(`Папка ${dir} уже существует`)
  process.exit(1)
}
fs.mkdirSync(dir, { recursive: true })

const name = nameArg ?? `Студия «${slugArg}»`
const config = {
  settings: {
    slug: slugArg,
    name,
    tagline: 'Короткий слоган студии',
    description: 'Описание студии: чем занимаетесь, чем отличаетесь. 2–3 предложения.',
    city: cityArg ?? 'Москва',
    address: 'ул. Примерная, 1',
    mapsUrl: 'https://yandex.ru/maps/',
    phone: '+7 (900) 000-00-00',
    contactMethods: [{ type: 'telegram', value: 'https://t.me/your_studio' }],
    tz: 'Europe/Moscow',
    accent: '#0f766e',
    theme: 'light',
    modes: { shoots: true, rental: false },
    status: 'demo',
    schedule: {
      mon: { open: '10:00', close: '20:00' },
      tue: { open: '10:00', close: '20:00' },
      wed: { open: '10:00', close: '20:00' },
      thu: { open: '10:00', close: '20:00' },
      fri: { open: '10:00', close: '20:00' },
      sat: { open: '10:00', close: '18:00' },
      sun: null,
    },
    closedDates: [],
    cancellation: { freeHours: 48, text: 'Опишите правила отмены.' },
    prepaymentDefault: { type: 'percent', value: 30 },
    travelZones: [{ id: 'city', name: 'по городу', minutesBefore: 0, minutesAfter: 0, extraFee: 0 }],
    infoCards: [
      { icon: 'camera', title: 'Как проходит съёмка', text: 'Опишите процесс.' },
      { icon: 'clock', title: 'Сроки сдачи', text: 'Когда клиент получит фото.' },
      { icon: 'shield', title: 'Гарантии', text: 'Что будет, если что-то пойдёт не так.' },
    ],
    reviews: [],
    reviewsEnabled: false,
    eveningFrom: '18:00',
  },
  specialists: [{ id: 'sp-main', name: 'Имя фотографа', title: 'фотограф', active: true, dayLimit: 2 }],
  halls: [],
  services: [
    {
      id: 'svc-portrait',
      kind: 'shoot',
      name: 'Портретная съёмка',
      description: 'Один час съёмки.',
      priceType: 'fixed',
      price: 5000,
      durationMin: 60,
      includes: ['1 час съёмки', '10 обработанных кадров'],
      deliverableText: '10 обработанных кадров',
      deadlineDays: 5,
      prepayment: { type: 'percent', value: 30 },
      needsSpecialist: true,
      needsHall: false,
      fullDay: false,
      multiDayMax: 1,
      autoConfirm: false,
      setupMin: 0,
      cleanupMin: 0,
      sort: 1,
    },
  ],
  addons: [],
  portfolio: [
    { id: 'pf-1', category: 'портрет', caption: 'Пример работы', kind: 'image', src: 'photos/portrait-1.svg', sort: 1 },
  ],
  seedBookings: [],
}

fs.writeFileSync(path.join(dir, 'tenant.json'), JSON.stringify(config, null, 2) + '\n')
placeholderPhotos()
console.log(`Создано tenants/${slugArg}/tenant.json (+ временные фото-заглушки)`)
console.log('Дальше:')
console.log(`  1. Отредактируйте tenants/${slugArg}/tenant.json (услуги, цены, фото)`)
console.log('  2. pnpm tenant:validate')
console.log('  3. pnpm tenant:assets && pnpm build  — проверить локально')
console.log('  4. pnpm tenant:push                  — залить в Supabase (нужны ключи в .env)')
