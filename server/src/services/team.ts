import { query, tx } from '../db'
import { conflict, notFound } from '../middleware/errors'
import { sendMail } from './mail'
import { revokeAllSessions } from './auth'

export interface TeamMember {
  userId: string
  email: string
  role: 'owner' | 'manager' | 'employee'
  joinedAt: string
}

export async function listMembers(studioId: string): Promise<TeamMember[]> {
  const r = await query<{ user_id: string; email: string; role: TeamMember['role']; created_at: Date }>(
    `select m.user_id, u.email::text as email, m.role, m.created_at
     from memberships m join users u on u.id = m.user_id
     where m.studio_id = $1 order by m.created_at`,
    [studioId]
  )
  return r.rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    role: row.role,
    joinedAt: new Date(row.created_at).toISOString(),
  }))
}

async function ownerCount(client: import('pg').PoolClient, studioId: string): Promise<number> {
  const r = await client.query(
    `select count(*)::int as n from memberships where studio_id = $1 and role = 'owner'`,
    [studioId]
  )
  return r.rows[0].n as number
}

async function isOwner(client: import('pg').PoolClient, studioId: string, userId: string): Promise<boolean> {
  const r = await client.query(
    `select 1 from memberships where studio_id = $1 and user_id = $2 and role = 'owner'`,
    [studioId, userId]
  )
  return r.rows.length > 0
}

// §3: нельзя удалить/понизить последнего owner; повышение выше своей роли невозможно
// (team:manage есть только у owner, потому любые изменения ролей делает owner).
export async function changeRole(
  studioId: string,
  targetUserId: string,
  newRole: 'owner' | 'manager' | 'employee'
): Promise<void> {
  await tx(async (c) => {
    const cur = await c.query(
      `select role from memberships where studio_id = $1 and user_id = $2`,
      [studioId, targetUserId]
    )
    if (cur.rows.length === 0) throw notFound('Участник не найден')
    const wasOwner = cur.rows[0].role === 'owner'
    const willBeOwner = newRole === 'owner'
    if (wasOwner && !willBeOwner && (await ownerCount(c, studioId)) <= 1) {
      throw conflict('LAST_OWNER', 'Нельзя понизить последнего владельца студии')
    }
    await c.query(`update memberships set role = $3 where studio_id = $1 and user_id = $2`, [
      studioId,
      targetUserId,
      newRole,
    ])
  })
}

export async function removeMember(
  studioId: string,
  targetUserId: string
): Promise<void> {
  await tx(async (c) => {
    const cur = await c.query(
      `select role from memberships where studio_id = $1 and user_id = $2`,
      [studioId, targetUserId]
    )
    if (cur.rows.length === 0) throw notFound('Участник не найден')
    if (cur.rows[0].role === 'owner' && (await ownerCount(c, studioId)) <= 1) {
      throw conflict('LAST_OWNER', 'Нельзя удалить последнего владельца студии')
    }
    await c.query(`delete from memberships where studio_id = $1 and user_id = $2`, [studioId, targetUserId])
    // доступ сгорает сразу, а не через 15 минут жизни access-токена
    await revokeAllSessions(targetUserId)
  })
}

// Возвращает true, если у студии остался хотя бы один owner после операции.
export async function notifyMember(inviteeEmail: string, studioName: string, role: string): Promise<void> {
  await sendMail(inviteeEmail, 'Вас добавили в студию', `Студия: ${studioName}. Роль: ${role}.`)
}
