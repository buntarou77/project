import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { apiFetch, ApiError } from '@/backend/apiFetch'

interface InviteInfo {
  studioName: string
  email: string | null
  role: string
}

export default function InvitePage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [exists, setExists] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<InviteInfo>(`/invitations/info?token=${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch(() => setInvalid(true))
  }, [token])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await apiFetch('/auth/register', {
        method: 'POST',
        json: { token, password, ...(info?.email ? {} : { email }) },
      })
      navigate('/owner')
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'USER_EXISTS') {
        sessionStorage.setItem('pf_pending_invite', token)
        setExists(true)
      } else {
        setError(err instanceof Error ? err.message : 'Ошибка регистрации')
      }
    } finally {
      setBusy(false)
    }
  }

  if (invalid) {
    return (
      <div className="center-page">
        <div className="card auth-card">
          <h2 style={{ fontSize: '1.4rem' }}>Приглашение недействительно или истекло</h2>
          <p className="muted small">Напишите в поддержку — мы вышлем новое приглашение.</p>
          <Link className="btn btn-block" to="/owner">На страницу входа</Link>
        </div>
      </div>
    )
  }

  if (exists) {
    return (
      <div className="center-page">
        <div className="card auth-card">
          <h2 style={{ fontSize: '1.4rem' }}>Аккаунт с таким email уже существует</h2>
          <p className="muted small">Войдите — приглашение применится автоматически.</p>
          <Link className="btn btn-primary btn-block" to="/owner">Войти</Link>
        </div>
      </div>
    )
  }

  if (!info) {
    return <div className="center-page"><p className="muted">Загружаем приглашение…</p></div>
  }

  return (
    <div className="center-page">
      <form className="card auth-card" onSubmit={submit}>
        <div className="overline">Приглашение</div>
        <h2 style={{ fontSize: '1.4rem' }}>Вас пригласили управлять студией «{info.studioName}»</h2>
        {info.email ? (
          <p className="small muted">Аккаунт: <strong>{info.email}</strong></p>
        ) : (
          <div className="field">
            <label>Email</label>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </div>
        )}
        <div className="field">
          <label>Пароль (минимум 8 символов)</label>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        {error && <p className="small" style={{ color: 'var(--bad)', fontWeight: 600 }}>{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy || password.length < 8}>
          {busy ? 'Создаём…' : 'Создать аккаунт и войти'}
        </button>
      </form>
    </div>
  )
}
