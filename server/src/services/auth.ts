import { query, tx } from '../db'
import { randomToken, sha256Hex, signAccess } from './tokens'
import { hashPassword, verifyPassword } from './passwords'
import { ApiHttpError } from '../middleware/errors'
import { setAuthCookies } from '../middleware/auth'
import type { Response } from 'express'
import { sendMail } from './mail'
import { config } from '../config'

// Как в services/bookings.ts: проверка кода ошибки PostgreSQL (там хелпер не экспортируется)
const isPgError = (e: unknown, code: string) =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === code

export interface UserStudiosItem {
  id: string
  slug: string
  name: string
  role: 'owner' | 'manager' | 'employee'
}

export async function userStudios(userId: string): Promise<UserStudiosItem[]> {
  const r = await query<{ id: string; slug: string; name: string; role: UserStudiosItem['role'] }>(
    `select s.id, s.slug, s.settings->>'name' as name, m.role
     from memberships m join studios s on s.id = m.studio_id
     where m.user_id = $1
     order by s.created_at`,
    [userId]
  )
  return r.rows
}

// Refresh: 32 байта base64url, в БД только sha256, ротация при каждом обновлении (§5.2).
async function createSession(
  userId: string,
  res: Response,
  ua?: string,
  ip?: string
): Promise<{ user: { id: string; email: string }; studios: UserStudiosItem[] }> {
  const refresh = randomToken()
  const access = signAccess(userId)
  await query(
    `insert into refresh_sessions (user_id, token_hash, expires_at, user_agent, ip_address)
     values ($1, $2, now() + interval '30 days', $3, $4)`,
    [userId, sha256Hex(refresh), ua ?? null, ip ?? null]
  )
  setAuthCookies(res, access, refresh)
  const u = await query<{ id: string; email: string }>(`select id, email from users where id = $1`, [userId])
  return { user: { id: u.rows[0].id, email: u.rows[0].email }, studios: await userStudios(userId) }
}

export async function login(
  email: string,
  password: string,
  res: Response,
  ua?: string,
  ip?: string
): Promise<{ user: { id: string; email: string }; studios: UserStudiosItem[] }> {
  const u = await query<{
    id: string
    email: string
    password_hash: string
  }>(`select id, email, password_hash from users where email = $1 and is_active = true`, [email])
  if (u.rows.length === 0) throw new ApiHttpError(401, 'INVALID_CREDENTIALS', 'Неверный email или пароль')
  const row = u.rows[0]
  const v = await verifyPassword(row.password_hash, password)
  if (!v.ok) throw new ApiHttpError(401, 'INVALID_CREDENTIALS', 'Неверный email или пароль')
  if (v.rehashToArgon) {
    // §5.1: bcrypt из Supabase → Argon2id прозрачно для пользователя
    await query(`update users set password_hash = $2, updated_at = now() where id = $1`, [row.id, v.rehashToArgon])
  }
  return createSession(row.id, res, ua, ip)
}

// Ротация: старая сессия отзывается, выдаётся новая пара токенов. Повторное
// предъявление уже ротированного токена считаем компрометацией и гасим все
// сессии пользователя. Перевод в отозванные атомарен (… and revoked_at is null),
// чтобы два параллельных refresh одним cookie не создали две живые сессии.
export async function rotateRefresh(
  refreshRaw: string | undefined,
  res: Response,
  ua?: string,
  ip?: string
): Promise<boolean> {
  if (!refreshRaw) return false
  const hash = sha256Hex(refreshRaw)
  const s = await query<{ user_id: string; revoked_at: Date | null; active: boolean }>(
    `select rs.user_id, rs.revoked_at, u.is_active as active
     from refresh_sessions rs
     join users u on u.id = rs.user_id
     where rs.token_hash = $1 and rs.expires_at > now()`,
    [hash]
  )
  if (s.rows.length === 0) return false
  const found = s.rows[0]
  if (found.revoked_at) {
    // Повтор того же cookie в первые секунды после ротации — почти всегда вторая
    // вкладка или потерянный Set-Cookie, а не кража: сессии не гасим
    const recent = await query(
      `select 1 from refresh_sessions
       where token_hash = $1 and revoked_at > now() - interval '30 seconds'`,
      [hash]
    )
    // токен использован давно и предъявлён снова: считаем его украденным
    if (recent.rows.length === 0) await revokeAllSessions(found.user_id)
    return false
  }
  if (!found.active) return false
  const userId = found.user_id
  return tx(async (c) => {
    const rotated = await c.query(
      `update refresh_sessions set revoked_at = now()
       where token_hash = $1 and revoked_at is null
       returning user_id`,
      [hash]
    )
    if (rotated.rows.length === 0) return false
    const refresh = randomToken()
    const access = signAccess(userId)
    await c.query(
      `insert into refresh_sessions (user_id, token_hash, expires_at, user_agent, ip_address)
       values ($1, $2, now() + interval '30 days', $3, $4)`,
      [userId, sha256Hex(refresh), ua ?? null, ip ?? null]
    )
    setAuthCookies(res, access, refresh)
    return true
  })
}

export async function logout(refreshRaw: string | undefined, res: Response): Promise<void> {
  if (refreshRaw) {
    await query(`update refresh_sessions set revoked_at = now() where token_hash = $1`, [sha256Hex(refreshRaw)])
  }
  res.clearCookie('pf_access')
  res.clearCookie('pf_refresh', { path: '/api/auth' })
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await query(`update refresh_sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId])
}

// Всегда 200 — не раскрываем существование аккаунта (§5.3).
export async function forgotPassword(email: string, webOrigin: string): Promise<void> {
  const u = await query<{ id: string; email: string }>(
    `select id, email from users where email = $1 and is_active = true`,
    [email]
  )
  if (u.rows.length === 0) return
  const raw = randomToken()
  await query(
    `insert into password_reset_tokens (user_id, token_hash, expires_at)
     values ($1, $2, now() + interval '1 hour')`,
    [u.rows[0].id, sha256Hex(raw)]
  )
  await sendMail(u.rows[0].email, 'Сброс пароля', `Ссылка для смены пароля (действует 1 час): ${webOrigin}/reset/${raw}`)
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const hash = await hashPassword(password)
  const userId = await tx<string | null>(async (c) => {
    // Одноразовость — атомарным погашением: условный UPDATE с RETURNING.
    // Параллельный запрос тем же токеном увидит 0 строк и получит отказ
    const used = await c.query<{ user_id: string }>(
      `update password_reset_tokens set used_at = now()
       where token_hash = $1 and used_at is null and expires_at > now()
       returning user_id`,
      [sha256Hex(token)]
    )
    if (used.rows.length === 0) return null
    const uid = used.rows[0].user_id as string
    await c.query(`update users set password_hash = $2, updated_at = now() where id = $1`, [uid, hash])
    await c.query(`update refresh_sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [uid])
    // остальные ссылки этого аккаунта тоже гасим: после смены пароля они не нужны
    await c.query(`update password_reset_tokens set used_at = now() where user_id = $1 and used_at is null`, [uid])
    return uid
  })
  if (userId === null) {
    throw new ApiHttpError(400, 'VALIDATION', 'Ссылка недействительна или истекла')
  }
}

// Активация приглашения новым пользователем (§5.3): одна транзакция.
export async function registerViaInvitation(
  raw: string,
  password: string,
  emailFromBody: string | undefined,
  res: Response,
  ua?: string,
  ip?: string
): Promise<{ user: { id: string; email: string }; studios: UserStudiosItem[] }> {
  const inv = await query<{ id: string; email: string | null; role: 'owner' | 'manager' | 'employee'; studio_id: string }>(
    `select id, email, role, studio_id from studio_invitations
     where token_hash = $1 and accepted_at is null and expires_at > now()`,
    [sha256Hex(raw)]
  )
  if (inv.rows.length === 0) {
    throw new ApiHttpError(400, 'INVITATION_INVALID', 'Приглашение недействительно или истекло')
  }
  const invitation = inv.rows[0]
  const email = invitation.email ?? emailFromBody
  if (!email) throw new ApiHttpError(400, 'VALIDATION', 'Укажите email')

  const existing = await query(`select id from users where email = $1`, [email])
  if (existing.rows.length > 0) throw new ApiHttpError(409, 'USER_EXISTS', 'Аккаунт с таким email уже существует')

  const passwordHash = await hashPassword(password)
  try {
    const created = await tx(async (c) => {
      // Приглашение гасим первым и атомарно: проигравший гонку не создаст аккаунт
      const claimed = await c.query(
        `update studio_invitations set accepted_at = now()
         where id = $1 and accepted_at is null and expires_at > now()
         returning id`,
        [invitation.id]
      )
      if (claimed.rows.length === 0) {
        throw new ApiHttpError(400, 'INVITATION_INVALID', 'Приглашение уже активировано или истекло')
      }
      const u = await c.query(
        `insert into users (email, password_hash) values ($1, $2) returning id, email`,
        [email, passwordHash]
      )
      await c.query(`insert into memberships (user_id, studio_id, role) values ($1, $2, $3)`, [
        u.rows[0].id,
        invitation.studio_id,
        invitation.role,
      ])
      return u.rows[0]
    })
    return await createSession(created.id, res, ua, ip)
  } catch (e) {
    // 23505 — уникальность email в БД: гонка параллельных регистраций одним приглашением
    if (isPgError(e, '23505')) {
      throw new ApiHttpError(409, 'USER_EXISTS', 'Аккаунт с таким email уже существует')
    }
    throw e
  }
}

// Приглашение для уже существующего аккаунта. Если пользователь уже состоит
// в студии — роль НЕ понижаем (владелец не должен стать менеджером от старой ссылки).
export async function acceptInvitationForExistingUser(
  raw: string,
  userId: string
): Promise<void> {
  const inv = await query<{ id: string; email: string | null; role: 'owner' | 'manager' | 'employee'; studio_id: string }>(
    `select id, email, role, studio_id from studio_invitations
     where token_hash = $1 and accepted_at is null and expires_at > now()`,
    [sha256Hex(raw)]
  )
  if (inv.rows.length === 0) {
    throw new ApiHttpError(400, 'INVITATION_INVALID', 'Приглашение недействительно или истекло')
  }
  // Приглашение, выпущенное на конкретный email, принимает только этот аккаунт:
  // ссылка могла уйти не тому человеку. Ссылка без email — обычный носитель секрета.
  if (inv.rows[0].email) {
    const me = await query<{ email: string }>(`select email::text as email from users where id = $1`, [userId])
    if ((me.rows[0]?.email ?? '').toLowerCase() !== inv.rows[0].email.toLowerCase()) {
      throw new ApiHttpError(403, 'INVITATION_EMAIL_MISMATCH', 'Приглашение выдано на другой email — войдите аккаунтом, указанным в приглашении')
    }
  }
  await tx(async (c) => {
    // Приглашение гасим первым и атомарно: проигравший гонку не создаст дубликат
    const claimed = await c.query(
      `update studio_invitations set accepted_at = now()
       where id = $1 and accepted_at is null and expires_at > now()
       returning id`,
      [inv.rows[0].id]
    )
    if (claimed.rows.length === 0) {
      throw new ApiHttpError(400, 'INVITATION_INVALID', 'Приглашение уже активировано или истекло')
    }
    await c.query(
      `insert into memberships (user_id, studio_id, role) values ($1, $2, $3)
       on conflict (user_id, studio_id) do nothing`,
      [userId, inv.rows[0].studio_id, inv.rows[0].role]
    )
  })
}
