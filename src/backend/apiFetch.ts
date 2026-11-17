import { apiBaseUrl } from '@/lib/env'

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message)
  }
}

type AuthCb = (signedIn: boolean) => void
const authCbs = new Set<AuthCb>()

export function onAuth(cb: AuthCb): () => void {
  authCbs.add(cb)
  return () => {
    authCbs.delete(cb)
  }
}

export function notifyAuthListeners(v: boolean) {
  authCbs.forEach((cb) => cb(v))
}

// Single-flight refresh: при параллельных 401 ротацию проходит только один
// запрос, остальные ждут его результата — иначе второй refresh пришёл бы с
// уже отозванным токеном и разлогинил бы пользователя.
let refreshInFlight: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const r = await fetch(`${apiBaseUrl}/api/auth/refresh`, { method: 'POST', credentials: 'include' })
        return r.ok
      } catch {
        return false
      } finally {
        setTimeout(() => (refreshInFlight = null), 0)
      }
    })()
  }
  return refreshInFlight
}

export async function apiFetch<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const run = async (): Promise<Response> =>
    fetch(`${apiBaseUrl}/api${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init?.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    })

  let res = await run()

  // access JWT истёк — один раз пробуем refresh и повторяем исходный запрос.
  // /auth/me сюда входит: иначе при живом refresh пользователь ложно
  // разлогинивался; ротацию не пробуют только сами auth-маршруты ротации/входа
  if (res.status === 401 && !(path === '/auth/login' || path === '/auth/refresh' || path === '/auth/logout')) {
    const refreshed = await tryRefresh()
    if (refreshed) res = await run()
    else notifyAuthListeners(false)
  }
  if (res.status === 401) notifyAuthListeners(false)

  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = data as { error?: { code?: string; message?: string } } | null
    throw new ApiError(err?.error?.code ?? 'INTERNAL', err?.error?.message ?? 'Ошибка сервера', res.status)
  }
  return data as T
}
