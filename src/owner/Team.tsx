import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { AsyncButton, ConfirmDialog, Section, Spinner } from '@/ui/common'
import { toast, toastError } from '@/ui/toast'

const ROLE_LABELS: Record<string, string> = {
  owner: 'Владелец',
  manager: 'Менеджер',
  employee: 'Сотрудник',
}

const ROLE_HINTS: Record<string, string> = {
  manager: 'Всё кроме команды: заявки, деньги, каталог',
  employee: 'Только просмотр заявок, без сумм',
}

// Раздел «Команда»: участники, приглашения, роли. API существует с самого
// начала (server team.ts + LAST_OWNER), здесь только UI.
export default function Team({ bundle, slug }: { bundle: StudioBundle; slug: string }) {
  const qc = useQueryClient()
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'manager' | 'employee'>('manager')
  const [removeTarget, setRemoveTarget] = useState<{ userId: string; email: string } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['owner-team', slug],
    queryFn: () => be.ownerTeamList!(slug),
    enabled: Boolean(be.ownerTeamList),
  })

  // B-54: статус SMTP — только в боевом API (демо метода не имеет, бейдж скрыт)
  const { data: smtp } = useQuery({
    queryKey: ['owner-smtp', slug],
    queryFn: () => be.ownerSmtpStatus!(slug),
    enabled: Boolean(be.ownerSmtpStatus),
  })

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ['owner-team', slug] })
    await qc.invalidateQueries({ queryKey: ['owner-studios'] })
  }

  async function invite() {
    if (!inviteEmail) return
    try {
      const res: unknown = await be.ownerTeamInvite!(slug, inviteEmail, inviteRole)
      // сервер теперь возвращает ссылку сразу: без SMTP это единственный способ
      // передать приглашение. Показываем её и копируем в буфер обмена
      const url = (res as { url?: string } | undefined)?.url
      if (url) {
        toast(`Приглашение создано. Ссылка для сотрудника: ${url}`)
        try {
          await navigator.clipboard.writeText(url)
        } catch {
          // буфер недоступен — ссылка уже показана в сообщении
        }
      } else {
        const smtpNote = smtp && !smtp.configured ? ' SMTP не настроен — письма не уходят.' : ''
        toast(`Приглашение создано. Ссылка придёт письмом при настроенном SMTP.${smtpNote}`)
      }
      setInviteEmail('')
      await refresh()
    } catch (e) {
      toastError(e)
    }
  }

  async function removeMember(userId: string) {
    try {
      await be.ownerTeamRemoveMember!(slug, userId)
      toast('Участник удалён, его сессии отозваны')
      await refresh()
    } catch (e) {
      toastError(e)
    }
  }

  if (!be.ownerTeamList) {
    return (
      <Section>
        <h2>Команда</h2>
        <p className="muted">Управление командой доступно в режиме боевого API (не в демо).</p>
      </Section>
    )
  }
  if (isLoading || !data) return <Spinner />

  const pending = data.invitations.filter((i) => !i.acceptedAtMs && i.expiresAtMs > Date.now())

  return (
    <Section>
      <h2>Команда</h2>
      <p className="small muted">
        Владелец управляет всем; менеджер — заявками и каталогом; сотрудник видит заявки без сумм.
        Последний владелец не удаляется (409 LAST_OWNER).
      </p>

      {data.members.map((m) => (
        <div className="card booking-row" key={m.userId} style={{ marginBottom: 10 }}>
          <div>
            <strong>{m.email}</strong>
            <div className="small muted">{ROLE_LABELS[m.role] ?? m.role}</div>
          </div>
          <div className="chips">
            {m.role !== 'owner' && (
              <button className="chip" onClick={() => setRemoveTarget({ userId: m.userId, email: m.email })}>
                Удалить
              </button>
            )}
          </div>
        </div>
      ))}

      <h3 style={{ marginTop: 22 }}>Пригласить</h3>
      {/* B-54: бейдж у SMTP-подсказки — владелец сразу видит, уйдёт ли письмо */}
      {be.ownerSmtpStatus && smtp && (
        <p
          className="small"
          role="status"
          style={{ margin: '0 0 8px', color: smtp.configured ? 'var(--ok)' : 'var(--warn)' }}
        >
          {smtp.configured ? 'SMTP настроен' : 'SMTP не настроен — письма не уходят'}
        </p>
      )}
      <div className="card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 2, minWidth: 200, marginBottom: 0 }}>
            <label>Email</label>
            <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="coworker@example.com" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Роль</label>
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'manager' | 'employee')}>
              <option value="manager">Менеджер — {ROLE_HINTS.manager}</option>
              <option value="employee">Сотрудник — {ROLE_HINTS.employee}</option>
            </select>
          </div>
          <AsyncButton className="btn btn-sm btn-primary" busyLabel="Создаём…" onClick={invite}>
            Пригласить
          </AsyncButton>
        </div>
        <p className="small muted" style={{ marginBottom: 0, marginTop: 10 }}>
          Приглашение одноразовое: получатель сам создаст пароль по ссылке. Без SMTP ссылка печатается в консоли сервера
          (pnpm studio:invite для повтора).
        </p>
      </div>

      {pending.length > 0 && (
        <>
          <h3 style={{ marginTop: 22 }}>Ожидают активации</h3>
          {pending.map((i) => (
            <div className="card booking-row" key={i.id} style={{ marginBottom: 8 }}>
              <div>
                <strong>{i.email ?? '—'}</strong>
                <div className="small muted">{ROLE_LABELS[i.role] ?? i.role} · до {new Date(i.expiresAtMs).toLocaleString('ru-RU')}</div>
              </div>
              <AsyncButton
                className="chip"
                busyLabel="Отзываем…"
                onClick={async () => {
                  try {
                    await be.ownerTeamRevokeInvitation!(slug, i.id)
                    toast('Приглашение отозвано')
                    await refresh()
                  } catch (e) {
                    toastError(e)
                  }
                }}
              >
                Отозвать
              </AsyncButton>
            </div>
          ))}
        </>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        title="Удалить участника?"
        text={removeTarget ? `${removeTarget.email} потеряет доступ к студии, его сессии будут отозваны.` : undefined}
        confirmLabel="Удалить"
        onConfirm={() => {
          if (removeTarget) void removeMember(removeTarget.userId)
          setRemoveTarget(null)
        }}
        onCancel={() => setRemoveTarget(null)}
      />
    </Section>
  )
}
