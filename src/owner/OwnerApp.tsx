import { useEffect, useState } from 'react'
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { backend as be, type StudioBundle } from '@/backend'
import { apiFetch } from '@/backend/apiFetch'
import { ErrorBox, Spinner } from '@/ui/common'
import { useStudioTheme } from '@/ui/theme'
import Requests from './Requests'
import OwnerCalendar from './Calendar'
import Deliveries from './Deliveries'
import Stats from './Stats'
import OwnerSettings from './Settings'
import OwnerPortfolio from './Portfolio'
import Team from './Team'
import AssistantWidget from '@/studio/AssistantWidget'

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [forgotInfo, setForgotInfo] = useState<string | null>(null)
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

  async function forgot() {
    setForgotInfo('Если аккаунт существует, мы отправили письмо со ссылкой')
    try {
      await apiFetch('/auth/forgot-password', { method: 'POST', json: { email } })
    } catch {
      // не раскрываем существование аккаунта
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
        {be.kind === 'express' && (
          <button type="button" className="chip" style={{ marginTop: 10 }} onClick={forgot}>
            Забыли пароль?
          </button>
        )}
        {forgotInfo && <p className="small muted" style={{ marginTop: 8 }}>{forgotInfo}</p>}
        <p className="small muted" style={{ marginBottom: 0, marginTop: 10 }}>
          В демо-режиме подойдёт любой email.
        </p>
      </form>
    </div>
  )
}

export default function OwnerApp() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [slug, setSlug] = useState(() => localStorage.getItem('pf_owner_slug') ?? 'kadr-studio')
  // B-79: проверка входа завершилась сбоем (сеть/5xx, не 401) — показываем
  // ошибку вместо вечного «Проверяем вход…»
  const [authError, setAuthError] = useState(false)

  useEffect(() => {
    be.ownerOnAuthChange((v) => {
      setAuthError(false)
      setSignedIn(v)
    })
    // B-79: ownerOnAuthChange (src/backend/express.ts) глотает любой сбой
    // /auth/me — сигнал об ошибке в компонент не доходит. Повторяем проверку
    // сами: 401 — это «не вошёл» (apiFetch сам уведомит listeners о false),
    // остальные сбои (сеть/5xx) выставляют authError.
    if (be.kind === 'express') {
      apiFetch('/auth/me')
        .then(() => setSignedIn(true))
        .catch((e) => {
          const status = (e as { status?: number }).status
          if (typeof status === 'number' && status >= 400 && status < 500) return
          setAuthError(true)
        })
    }
  }, [])

  // Список студий — через React Query: Settings инвалидирует его после
  // сохранения, поэтому переименование сразу видно в селекторе.
  // Express API; иначе фолбэк — /tenants/index.json (демо/переходный период).
  const { data: studios = [] } = useQuery({
    queryKey: ['owner-studios', signedIn],
    queryFn: async (): Promise<{ slug: string; name: string; role: string }[]> => {
      if (be.ownerStudios) {
        const items = await be.ownerStudios()
        return items.map(({ slug: s, name, role }) => ({ slug: s, name, role }))
      }
      const r = await fetch('/tenants/index.json')
      if (!r.ok) return []
      const list = await r.json()
      return Array.isArray(list) ? (list as { slug: string; name: string }[]).map((x) => ({ ...x, role: 'owner' })) : []
    },
    enabled: Boolean(signedIn),
    staleTime: 30_000,
  })

  // Приглашение, отложенное до входа (страница /invite при USER_EXISTS)
  useEffect(() => {
    if (!signedIn || be.kind !== 'express') return
    const pending = sessionStorage.getItem('pf_pending_invite')
    if (!pending) return
    apiFetch('/auth/invitations/accept', { method: 'POST', json: { token: pending } })
      .then(() => sessionStorage.removeItem('pf_pending_invite'))
      .catch((e) => {
        // окончательный отказ сервера (4xx) — токен больше не пригодится; при
        // сбое сети или 5xx оставляем, чтобы попробовать после следующего входа
        const status = (e as { status?: number }).status
        if (typeof status === 'number' && status >= 400 && status < 500) {
          sessionStorage.removeItem('pf_pending_invite')
        }
      })
  }, [signedIn])

  useEffect(() => {
    localStorage.setItem('pf_owner_slug', slug)
  }, [slug])

  // Текущая студия пропала из списка → переключаемся на первую доступную
  useEffect(() => {
    if (studios.length > 0 && !studios.some((s) => s.slug === slug)) {
      setSlug(studios[0].slug)
    }
  }, [studios, slug])

  const { data: bundle, isLoading, isError: bundleError, refetch: refetchBundle } = useQuery({
    queryKey: ['studio', slug],
    queryFn: () => be.loadStudio(slug),
    enabled: Boolean(signedIn),
    staleTime: 0,
    refetchOnMount: 'always',
  })

  // тема и акцент студии действуют и в кабинете: смена темы в настройках
  // перекрашивает кабинет сразу после «Сохранить настройки» (рефетч бандла)
  useStudioTheme(bundle?.settings)

  // B-79: сбой проверки входа — не вечный спиннер
  if (authError && signedIn === null)
    return (
      <ErrorBox>
        Не удалось проверить вход. Проверьте соединение и повторите.{' '}
        <button className="btn btn-sm" onClick={() => window.location.reload()}>Повторить</button>
      </ErrorBox>
    )
  if (signedIn === null) return <Spinner label="Проверяем вход…" />
  // B-75: перед входом чистим кэш React Query — после выхода данные
  // предыдущего аккаунта не должны всплывать у следующего
  if (!signedIn)
    return (
      <Login
        onDone={() => {
          queryClient.clear()
          setSignedIn(true)
        }}
      />
    )
  // B-79: сбой загрузки студии — ErrorBox с повтором, а не бесконечный спиннер.
  // Фоновый сбой при уже загруженных данных данные не заменяет
  if (bundleError && !bundle)
    return (
      <ErrorBox>
        Не удалось загрузить студию.{' '}
        <button className="btn btn-sm" onClick={() => refetchBundle()}>Повторить</button>
      </ErrorBox>
    )
  if (isLoading || !bundle) return <Spinner />

  const b = bundle as StudioBundle
  const accentStyle = { '--accent': b.settings.accent } as React.CSSProperties

  // Роль в текущей студии: вкладки скрываем по правам (ROLE_PERMISSIONS §3),
  // чтобы сотрудник не тыкал в разделы с 403. Фолбэк — employee: пока список
  // студий грузится, лишних вкладок и сумм лучше не показывать.
  const role = studios.find((st) => st.slug === slug)?.role ?? 'employee'
  const isOwner = role === 'owner'
  const isManager = role === 'owner' || role === 'manager'
  const tabs: [string, string, boolean][] = [
    ['requests', 'Заявки', true],
    ['calendar', 'Календарь', true],
    ['deliveries', 'Сдачи', isManager],
    ['stats', 'Статистика', isManager],
    ['portfolio', 'Портфолио', isManager],
    ['settings', 'Настройки', isManager],
    ['team', 'Команда', isOwner && Boolean(be.ownerTeamList)],
  ]

  return (
    <div className="container page-with-nav" style={{ maxWidth: 900, ...accentStyle }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingTop: 18 }}>
        <div>
          <div className="overline" style={{ marginBottom: 0 }}>Кабинет владельца</div>
          <h2 style={{ margin: 0 }}>{b.settings.name}</h2>
        </div>
        <div className="chips">
          {studios.length > 0 && (
            <select className="chip" value={slug} onChange={(e) => setSlug(e.target.value)} style={{ padding: '8px 12px' }} aria-label="Студия">
              {studios.map((st) => (
                <option key={st.slug} value={st.slug}>{st.name}</option>
              ))}
            </select>
          )}
          <a className="chip" href={`/s/${slug}`} target="_blank" rel="noopener noreferrer" title="Открыть витрину студии в новой вкладке">
            Витрина ↗
          </a>
          {/* B-75: чистим кэш ДО смены состояния выхода — запросы кабинета
              не должны переживать logout (кэш между аккаунтами) */}
          <button
            className="chip"
            onClick={async () => {
              queryClient.clear()
              await be.ownerSignOut()
              navigate('/owner')
            }}
          >
            Выйти
          </button>
        </div>
      </div>

      <nav className="owner-nav">
        {tabs.filter(([, , visible]) => visible).map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => `chip ${isActive ? 'active' : ''}`}>
            {label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route index element={<Requests bundle={b} slug={slug} role={role} />} />
        <Route path="requests" element={<Requests bundle={b} slug={slug} role={role} />} />
        <Route path="calendar" element={<OwnerCalendar bundle={b} slug={slug} />} />
        {isManager && <Route path="deliveries" element={<Deliveries bundle={b} slug={slug} />} />}
        {isManager && <Route path="stats" element={<Stats bundle={b} slug={slug} />} />}
        {isManager && <Route path="portfolio" element={<OwnerPortfolio bundle={b} slug={slug} />} />}
        {/* key: настройки живут в локальном state — при смене студии обязаны
            перемонтироваться, иначе владелец правит настройки чужой студии */}
        {isManager && <Route path="settings" element={<OwnerSettings key={slug} bundle={b} slug={slug} />} />}
        {isOwner && <Route path="team" element={<Team bundle={b} slug={slug} />} />}
      </Routes>
      <AssistantWidget slug={slug} kind="owner" />
    </div>
  )
}
