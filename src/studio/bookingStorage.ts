// Токены «Моих записей» на устройстве клиента: список, а не одна последняя —
// при повторной записи предыдущие ссылки не теряются.
const KEY = 'pf_bookings_list'

export interface StoredBooking {
  token: string
  serviceName: string
  startsAtMs: number
  createdAtMs: number
}

function read(slug: string): StoredBooking[] {
  try {
    return JSON.parse(localStorage.getItem(`${KEY}_${slug}`) ?? '[]') as StoredBooking[]
  } catch {
    return []
  }
}

function write(slug: string, list: StoredBooking[]) {
  try {
    localStorage.setItem(`${KEY}_${slug}`, JSON.stringify(list))
  } catch {}
}

export function saveBooking(slug: string, b: StoredBooking) {
  const list = read(slug).filter((x) => x.token !== b.token)
  write(slug, [b, ...list])
}

// легаси-алиасы: последняя запись
export const saveLastToken = (slug: string, token: string) => {
  const existing = read(slug).find((x) => x.token === token)
  saveBooking(slug, existing ?? { token, serviceName: '', startsAtMs: 0, createdAtMs: Date.now() })
}
export const getLastToken = (slug: string): string | null => read(slug)[0]?.token ?? null
export const clearLastToken = (slug: string) => {
  const [first, ...rest] = read(slug)
  if (first) write(slug, rest)
}

export const listBookings = (slug: string): StoredBooking[] => read(slug)
export const removeBooking = (slug: string, token: string) => write(slug, read(slug).filter((x) => x.token !== token))
