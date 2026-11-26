import { apiFetch, ApiError, onAuth, notifyAuthListeners } from './apiFetch'
import type { Backend, BookingFilters, BookingRecord, StudioBundle } from './types'
import type { PriceBreakdown } from '@/core/price'
import type { CreateBookingPayload } from '@/core/schema'
import type { TenantSettings } from '@/core/types'
import { compressImage } from '@/lib/image'

// Боевой адаптер: собственный Express API, авторизация через HttpOnly cookies.
// Форматы ответов 1:1 с доменными типами (camelCase, ms-эпохи) — см. src/backend/types.ts.

function enc(v: string): string {
  return encodeURIComponent(v)
}

export const expressBackend: Backend = {
  kind: 'express',

  // ---------- витрина и клиент ----------

  async loadStudio(slug) {
    return apiFetch<StudioBundle>(`/public/studios/${enc(slug)}`)
  },

  async getAvailability(q) {
    const { slug, ...body } = q
    const r = await apiFetch<{ slots: { startMs: number; specialistId: string | null }[]; reason: string | null }>(
      `/public/studios/${enc(slug)}/availability`,
      { method: 'POST', json: body }
    )
    return { slots: r.slots, reason: r.reason ?? undefined }
  },

  async createBooking(payload: CreateBookingPayload) {
    const { slug, ...body } = payload
    try {
      const r = await apiFetch<{ ok: true; token?: string; duplicate?: boolean; price?: unknown }>(
        `/public/studios/${enc(slug)}/bookings`,
        { method: 'POST', json: body }
      )
      // при дубликате токена нет — берём сохранённый ранее
      return { ok: true as const, token: r.token ?? '', price: r.price as PriceBreakdown | undefined, duplicate: r.duplicate ?? false }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : 'Ошибка сервера' }
    }
  },

  async getMyBooking(slug, token) {
    try {
      return await apiFetch<BookingRecord>(
        `/public/studios/${enc(slug)}/bookings/${enc(token)}`
      )
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  },

  async cancelMyBooking(slug, token) {
    try {
      await apiFetch(`/public/studios/${enc(slug)}/bookings/${enc(token)}/cancel`, { method: 'POST' })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Ошибка сервера' }
    }
  },

  async requestAssistant(slug, message, kind) {
    const path =
      kind === 'client'
        ? `/public/studios/${enc(slug)}/assistant`
        : `/owner/studios/${enc(slug)}/assistant`
    try {
      const r = await apiFetch<{ reply: string }>(path, { method: 'POST', json: { message } })
      // C4: пустой reply (бюджет исчерпан и т.п.) — подставляем человекочитаемый текст
      if (!r.reply) return { reply: 'Лимит помощника на сегодня исчерпан. Напишите владельцу в мессенджер.', unavailable: true }
      return { reply: r.reply }
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0
      if (status === 429 || status === 401 || status === 403) {
        return { reply: 'Лимит помощника на сегодня исчерпан. Напишите владельцу в мессенджер.', unavailable: true }
      }
      return { reply: 'Помощник временно недоступен. Напишите владельцу в мессенджер.', unavailable: true }
    }
  },

  // ---------- push-уведомления витрины ----------

  async pushKey(slug) {
    return apiFetch<{ publicKey: string | null }>(`/public/studios/${enc(slug)}/push-key`)
  },

  async pushSubscribe(slug, sub, token) {
    // токен брони: сервер привязывает подписку к записи — напоминание придёт только по ней
    await apiFetch(`/public/studios/${enc(slug)}/push-subscribe`, { method: 'POST', json: { ...sub, token } })
  },

  async pushUnsubscribe(slug, endpoint) {
    await apiFetch(`/public/studios/${enc(slug)}/push-unsubscribe`, { method: 'POST', json: { endpoint } })
  },

  // ---------- авторизация ----------

  async ownerSignIn(email, password) {
    try {
      await apiFetch('/auth/login', { method: 'POST', json: { email, password } })
      notifyAuthListeners(true)
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Ошибка входа')
    }
  },

  async ownerSignOut() {
    try {
      await apiFetch('/auth/logout', { method: 'POST' })
    } catch {
      // выходим локально в любом случае
    }
    notifyAuthListeners(false)
  },

  ownerOnAuthChange(cb) {
    const off = onAuth(cb)
    return off
  },

  async ownerStudios() {
    const r = await apiFetch<{ items: { id: string; slug: string; name: string; role: string }[] }>('/owner/studios')
    return r.items
  },

  // ---------- кабинет ----------

  async ownerBookings(slug, filters: BookingFilters = {}) {
    // сервер отдаёт страницы по ≤500 — собираем всё, фильтры живут в кабинете
    const all: BookingRecord[] = []
    let cursor = 0
    for (;;) {
      const p = new URLSearchParams()
      if (filters.status && filters.status !== 'all') p.set('status', filters.status)
      if (filters.specialistId) p.set('specialistId', filters.specialistId)
      if (filters.hallId) p.set('hallId', filters.hallId)
      if (filters.dateFrom) p.set('dateFrom', filters.dateFrom)
      if (filters.dateTo) p.set('dateTo', filters.dateTo)
      p.set('limit', '200')
      p.set('cursor', String(cursor))
      const r = await apiFetch<{ items: BookingRecord[]; nextCursor: number | null }>(
        `/owner/studios/${enc(slug)}/bookings?${p.toString()}`
      )
      all.push(...r.items)
      if (r.nextCursor === null || r.items.length === 0) break
      cursor = r.nextCursor
    }
    return all
  },

  async ownerUpdateBooking(slug, id, patch) {
    await apiFetch(`/owner/studios/${enc(slug)}/bookings/${enc(id)}`, { method: 'PATCH', json: patch })
  },

  async ownerCreateBookingManual(slug, record) {
    await apiFetch(`/owner/studios/${enc(slug)}/bookings`, { method: 'POST', json: record })
  },

  async ownerSaveSettings(slug, settings: TenantSettings) {
    await apiFetch(`/owner/studios/${enc(slug)}/settings`, { method: 'PUT', json: settings })
  },

  async ownerSetHero(slug, url) {
    await apiFetch(`/owner/studios/${enc(slug)}/settings/hero`, { method: 'PATCH', json: { heroPhotoUrl: url } })
  },

  async ownerDeleteHeroFile(slug, url) {
    await apiFetch(`/owner/studios/${enc(slug)}/settings/hero-file`, { method: 'DELETE', json: { url } })
  },

  async ownerSmtpStatus(slug) {
    return apiFetch<{ configured: boolean }>(`/owner/studios/${enc(slug)}/smtp-status`)
  },

  async ownerUpsertSpecialist(slug, item) {
    await apiFetch(`/owner/studios/${enc(slug)}/specialists`, { method: 'POST', json: item })
  },

  async ownerDeleteSpecialist(slug, id) {
    await apiFetch(`/owner/studios/${enc(slug)}/specialists/${enc(id)}`, { method: 'DELETE' })
  },

  async ownerUploadSpecialistPhoto(slug, file) {
    const { variants } = await compressImage(file)
    const fd = new FormData()
    fd.append('file', variants[640], 'photo-640.jpg')
    return apiFetch<{ src: string }>(`/owner/studios/${enc(slug)}/specialists/upload`, {
      method: 'POST',
      body: fd,
    })
  },

  async ownerUpsertHall(slug, item) {
    await apiFetch(`/owner/studios/${enc(slug)}/halls`, { method: 'POST', json: item })
  },

  async ownerDeleteHall(slug, id) {
    await apiFetch(`/owner/studios/${enc(slug)}/halls/${enc(id)}`, { method: 'DELETE' })
  },

  async ownerUploadHallPhoto(slug, file) {
    const { variants } = await compressImage(file)
    const fd = new FormData()
    fd.append('file', variants[640], 'photo-640.jpg')
    return apiFetch<{ src: string }>(`/owner/studios/${enc(slug)}/halls/upload`, {
      method: 'POST',
      body: fd,
    })
  },

  async ownerUpsertService(slug, item) {
    await apiFetch(`/owner/studios/${enc(slug)}/services`, { method: 'POST', json: item })
  },

  async ownerUpdateServiceAddons(slug, serviceId, addonIds) {
    await apiFetch(`/owner/studios/${enc(slug)}/services/${enc(serviceId)}/addons`, { method: 'PATCH', json: { addonIds } })
  },

  async ownerDeleteService(slug, id) {
    await apiFetch(`/owner/studios/${enc(slug)}/services/${enc(id)}`, { method: 'DELETE' })
  },

  async ownerUpsertAddon(slug, item) {
    await apiFetch(`/owner/studios/${enc(slug)}/addons`, { method: 'POST', json: item })
  },

  async ownerDeleteAddon(slug, id) {
    await apiFetch(`/owner/studios/${enc(slug)}/addons/${enc(id)}`, { method: 'DELETE' })
  },

  async ownerAnonymizeClient(slug, bookingId) {
    await apiFetch(`/owner/studios/${enc(slug)}/bookings/${enc(bookingId)}/anonymize`, { method: 'POST' })
  },

  async ownerBookingReferences(slug, bookingId) {
    const r = await apiFetch<{ items: { id: string; url: string; sort: number }[] }>(
      `/owner/studios/${enc(slug)}/bookings/${enc(bookingId)}/references`
    )
    return r.items
  },

  async uploadBookingReferences(slug, token, files) {
    const fd = new FormData()
    for (const f of files) fd.append('files', f, f.name || 'reference.jpg')
    const r = await apiFetch<{ count: number }>(
      `/public/studios/${enc(slug)}/bookings/${enc(token)}/references`,
      { method: 'POST', body: fd }
    )
    return { count: r.count }
  },

  async ownerUploadPortfolioPhoto(slug, file) {
    const { variants } = await compressImage(file)
    const fd = new FormData()
    fd.append('file640', variants[640], 'photo-640.jpg')
    if (variants[1024]) fd.append('file1024', variants[1024], 'photo-1024.jpg')
    if (variants[1600]) fd.append('file1600', variants[1600], 'photo-1600.jpg')
    return apiFetch<{ src: string; srcset?: string }>(
      `/owner/studios/${enc(slug)}/portfolio/upload`,
      { method: 'POST', body: fd }
    )
  },

  async ownerUpsertPortfolioItem(slug, item) {
    await apiFetch(`/owner/studios/${enc(slug)}/portfolio`, { method: 'POST', json: item })
  },

  async ownerDeletePortfolioItem(slug, id) {
    await apiFetch(`/owner/studios/${enc(slug)}/portfolio/${enc(id)}`, { method: 'DELETE' })
  },

  async ownerCalendarToken(slug) {
    try {
      const r = await apiFetch<{ token: string }>(`/owner/studios/${enc(slug)}/calendar-token`)
      return r.token
    } catch {
      return null
    }
  },

  // ---------- команда ----------

  async ownerTeamList(slug) {
    const r = await apiFetch<{
      members: { userId: string; email: string; role: 'owner' | 'manager' | 'employee'; joinedAt?: string }[]
      invitations: { id: string; email: string | null; role: 'owner' | 'manager' | 'employee'; expiresAt: string; acceptedAt: string | null }[]
    }>(`/owner/studios/${enc(slug)}/team`)
    // B8: сервер отдаёт ISO-строки (joinedAt/expiresAt/acceptedAt) — приводим
    // к ms-эпохам контракта Backend, а не кастуем вслепую
    return {
      members: r.members.map((m) => ({
        userId: m.userId,
        email: m.email,
        role: m.role,
        createdAtMs: m.joinedAt ? Date.parse(m.joinedAt) : undefined,
      })),
      invitations: r.invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAtMs: Date.parse(i.expiresAt),
        acceptedAtMs: i.acceptedAt ? Date.parse(i.acceptedAt) : null,
      })),
    }
  },

  async ownerTeamInvite(slug, email, role) {
    // B-25: сервер отдаёт ссылку-приглашение в url — не отбрасываем результат
    return apiFetch<{ url?: string }>(`/owner/studios/${enc(slug)}/invitations`, { method: 'POST', json: { email, role } })
  },

  async ownerTeamRevokeInvitation(slug, invitationId) {
    await apiFetch(`/owner/studios/${enc(slug)}/invitations/${enc(invitationId)}`, { method: 'DELETE' })
  },

  async ownerTeamRemoveMember(slug, userId) {
    await apiFetch(`/owner/studios/${enc(slug)}/members/${enc(userId)}`, { method: 'DELETE' })
  },

  // ---------- закрытые периоды ----------

  async ownerClosedPeriods(slug) {
    const r = await apiFetch<{ items: import('@/core/types').ClosedPeriod[] }>(
      `/owner/studios/${enc(slug)}/closed-periods`
    )
    return r.items
  },

  async ownerUpsertClosedPeriod(slug, item) {
    return apiFetch<{ conflicts?: import('./types').ClosedPeriodConflict[] }>(
      `/owner/studios/${enc(slug)}/closed-periods`,
      { method: 'POST', json: item }
    )
  },

  async ownerDeleteClosedPeriod(slug, id) {
    await apiFetch(`/owner/studios/${enc(slug)}/closed-periods/${enc(id)}`, { method: 'DELETE' })
  },

  async ownerUploadServicePhoto(slug, file) {
    const { variants } = await compressImage(file)
    const fd = new FormData()
    fd.append('file', variants[640], 'photo-640.jpg')
    return apiFetch<{ src: string }>(`/owner/studios/${enc(slug)}/services/upload`, {
      method: 'POST',
      body: fd,
    })
  },

  async ownerUploadHeroPhoto(slug, file) {
    const { variants } = await compressImage(file)
    // фон шапки тянется на весь экран — берём самый крупный вариант (до 1600px)
    const best = variants[1600] ?? variants[1024] ?? variants[640]
    const fd = new FormData()
    fd.append('file', best, 'hero.jpg')
    return apiFetch<{ src: string }>(`/owner/studios/${enc(slug)}/hero/upload`, {
      method: 'POST',
      body: fd,
    })
  },
}
