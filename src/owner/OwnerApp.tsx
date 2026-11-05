import { useEffect, useState } from 'react'
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { ErrorBox, Spinner } from '@/ui/common'
import Requests from './Requests'
import OwnerCalendar from './Calendar'
import Deliveries from './Deliveries'
import Stats from './Stats'
import OwnerSettings from './Settings'
import OwnerPortfolio from './Portfolio'

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await be.ownerSignIn(email, password)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка входа')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center-page">
      <form className="card auth-card" onSubmit={submit}>
        <div className="overline">Кабинет владельца</div>
        <h2 style={{ fontSize: '1.6rem' }}>Вход</h2>
        <div className="field">
          <label>Email</label>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </div>
        <div className="field">
          <label>Пароль</label>
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Входим…' : 'Войти'}</button>
        <p className="small muted" style={{ marginBottom: 0, marginTop: 10 }}>
          В демо-режиме подойдёт любой email.
        </p>
      </form>
    </div>
  )
}

export default function OwnerApp() {
  const navigate = useNavigate()
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [slug, setSlug] = useState(() => localStorage.getItem('pf_owner_slug') ?? 'kadr-studio')
  const [studios, setStudios] = useState<{ slug: string; name: string }[]>([
    { slug: 'kadr-studio', name: 'Фотостудия «Кадр»' },
    { slug: 'anna-vetrova', name: 'Анна Ветрова' },
  ])

  useEffect(() => {
    be.ownerOnAuthChange((v) => setSignedIn(v))
    fetch('/tenants/index.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => Array.isArray(list) && list.length > 0 && setStudios(list))
      .catch(() => {})
  }, [])

  useEffect(() => {
    localStorage.setItem('pf_owner_slug', slug)
  }, [slug])

  const { data: bundle, isLoading } = useQuery({
    queryKey: ['studio', slug],
    queryFn: () => be.loadStudio(slug),
    enabled: Boolean(signedIn),
  })

  if (signedIn === null) return <Spinner label="Проверяем вход…" />
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />
  if (isLoading || !bundle) return <Spinner />

  const b = bundle as StudioBundle

  return (
    <div className="container page-with-nav" style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingTop: 18 }}>
        <div>
          <div className="overline" style={{ marginBottom: 0 }}>Кабинет владельца</div>
          <h2 style={{ margin: 0 }}>{b.settings.name}</h2>
        </div>
        <div className="chips">
          <select className="chip" value={slug} onChange={(e) => setSlug(e.target.value)} style={{ padding: '8px 12px' }} aria-label="Студия">
            {studios.map((st) => (
              <option key={st.slug} value={st.slug}>{st.name}</option>
            ))}
          </select>
          <button className="chip" onClick={async () => { await be.ownerSignOut(); navigate('/owner') }}>Выйти</button>
        </div>
      </div>

      <nav className="owner-nav">
        {[
          ['requests', 'Заявки'],
          ['calendar', 'Календарь'],
          ['deliveries', 'Сдачи'],
          ['stats', 'Статистика'],
          ['portfolio', 'Портфолио'],
          ['settings', 'Настройки'],
        ].map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => `chip ${isActive ? 'active' : ''}`}>
            {label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route index element={<Requests bundle={b} slug={slug} />} />
        <Route path="requests" element={<Requests bundle={b} slug={slug} />} />
        <Route path="calendar" element={<OwnerCalendar bundle={b} slug={slug} />} />
        <Route path="deliveries" element={<Deliveries bundle={b} slug={slug} />} />
        <Route path="stats" element={<Stats bundle={b} slug={slug} />} />
        <Route path="portfolio" element={<OwnerPortfolio bundle={b} slug={slug} />} />
        <Route path="settings" element={<OwnerSettings bundle={b} slug={slug} />} />
      </Routes>
    </div>
  )
}
