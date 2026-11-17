import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { apiFetch, ApiError } from '@/backend/apiFetch'
import { ErrorBox } from '@/ui/common'

export default function ResetPage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (password !== repeat) {
      setError('Пароли не совпадают')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await apiFetch('/auth/reset-password', { method: 'POST', json: { token, password } })
      navigate('/owner')
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setInvalid(true)
      else setError(err instanceof Error ? err.message : 'Ошибка')
    } finally {
      setBusy(false)
    }
  }

  if (invalid) {
    return (
      <div className="center-page">
        <div className="card auth-card">
          <h2 style={{ fontSize: '1.4rem' }}>Ссылка недействительна или истекла</h2>
          <p className="muted small">Запросите новую ссылку на странице входа.</p>
          <Link className="btn btn-primary btn-block" to="/owner">Запросить новую</Link>
        </div>
      </div>
    )
  }

  return (
    <div className="center-page">
      <form className="card auth-card" onSubmit={submit}>
        <div className="overline">Новый пароль</div>
        <h2 style={{ fontSize: '1.6rem' }}>Смена пароля</h2>
        <div className="field">
          <label>Новый пароль (минимум 8 символов)</label>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="field">
          <label>Повторите пароль</label>
          <input
            type="password"
            required
            minLength={8}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <button className="btn btn-primary btn-block" disabled={busy || password.length < 8}>
          {busy ? 'Сохраняем…' : 'Сохранить пароль'}
        </button>
      </form>
    </div>
  )
}
