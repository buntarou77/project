import { randomToken, sha256Hex } from './tokens'
import { query } from '../db'
import { ApiHttpError } from '../middleware/errors'
import { sendMail } from './mail'
import { config } from '../config'

const HOUR = 3600 * 1000

export interface InvitationView {
  id: string
  email: string | null
  role: 'owner' | 'manager' | 'employee'
  expiresAt: string
  acceptedAt?: string | null
  url?: string
}

// §6: с email — 7 дней и письмо; без email — ссылка любым каналом, 48 часов.
export async function createInvitation(opts: {
  studioId: string
  email: string | null
  role: 'owner' | 'manager' | 'employee'
}): Promise<InvitationView> {
  const raw = randomToken()
  const ttlHours = opts.email ? 7 * 24 : 48
  const expiresAt = new Date(Date.now() + ttlHours * HOUR)
  const r = await query<{ id: string }>(
    `insert into studio_invitations (studio_id, email, role, token_hash, expires_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [opts.studioId, opts.email, opts.role, sha256Hex(raw), expiresAt]
  )
  const url = `${config.WEB_ORIGIN}/invite/${raw}`
  if (opts.email) {
    await sendMail(
      opts.email,
      'Приглашение в студию',
      `Вас пригласили управлять студией. Активируйте приглашение в течение ${ttlHours} часов: ${url}`
    )
  }
  return {
    id: r.rows[0].id,
    email: opts.email,
    role: opts.role,
    expiresAt: expiresAt.toISOString(),
    url,
  }
}

// Данные для страницы активации /invite/:token (§7.2).
export async function infoByToken(raw: string): Promise<{
  studioName: string
  email: string | null
  role: string
}> {
  const r = await query<{ studio_name: string; email: string | null; role: string }>(
    `select s.settings->>'name' as studio_name, i.email, i.role
     from studio_invitations i join studios s on s.id = i.studio_id
     where i.token_hash = $1 and i.accepted_at is null and i.expires_at > now()`,
    [sha256Hex(raw)]
  )
  if (r.rows.length === 0) {
    throw new ApiHttpError(400, 'INVITATION_INVALID', 'Приглашение недействительно или истекло')
  }
  return { studioName: r.rows[0].studio_name, email: r.rows[0].email, role: r.rows[0].role }
}

export async function listForStudio(studioId: string): Promise<InvitationView[]> {
  const r = await query<{
    id: string
    email: string | null
    role: 'owner' | 'manager' | 'employee'
    expires_at: Date
    accepted_at: Date | null
  }>(
    `select id, email, role, expires_at, accepted_at from studio_invitations
     where studio_id = $1 order by created_at desc`,
    [studioId]
  )
  return r.rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    expiresAt: new Date(row.expires_at).toISOString(),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
  }))
}

export async function revokeInvitation(studioId: string, id: string): Promise<boolean> {
  const r = await query(
    `delete from studio_invitations where id = $1 and studio_id = $2 and accepted_at is null`,
    [id, studioId]
  )
  return (r.rowCount ?? 0) > 0
}

export function hashOf(raw: string): string {
  return sha256Hex(raw)
}
