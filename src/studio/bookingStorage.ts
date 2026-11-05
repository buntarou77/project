const KEY = 'pf_last_booking'

export function saveLastToken(slug: string, token: string) {
  try {
    localStorage.setItem(`${KEY}_${slug}`, token)
  } catch {}
}

export function getLastToken(slug: string): string | null {
  try {
    return localStorage.getItem(`${KEY}_${slug}`)
  } catch {
    return null
  }
}

export function clearLastToken(slug: string) {
  try {
    localStorage.removeItem(`${KEY}_${slug}`)
  } catch {}
}
