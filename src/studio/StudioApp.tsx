import { useEffect, useState } from 'react'
import { NavLink, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { House, Images, Tag, CalendarCheck, Gear } from '@phosphor-icons/react'
import { backend } from '@/backend'
import { apiFetch } from '@/backend/apiFetch'
import { DemoFlag, ErrorBox, Spinner } from '@/ui/common'
import { useStudioTheme } from '@/ui/theme'
import HomePage from './HomePage'
import WorksPage from './WorksPage'
import ServicesPage from './ServicesPage'
import BookPage from './BookPage'
import MyBookingPage from './MyBookingPage'
import PolicyPage from './PolicyPage'
import AssistantWidget from './AssistantWidget'
import { getLastToken } from './bookingStorage'

// Вход в кабинет с витрины: чип виден только владельцу этой студии.
// Аноним обходится одним /auth/me (без попыток refresh) и не видит ничего —
// на публичной витрине нет никаких «админских» ссылок. В демо показываем
// всегда: образец должен демонстрировать и кабинет.
function OwnerEntrance({ slug }: { slug: string }) {
  const [canManage, setCanManage] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true
    setCanManage(false)
    ;(async () => {
      if (backend.kind === 'demo') {
        if (alive) setCanManage(true)
        return
      }
      try {
        await apiFetch('/auth/me')
      } catch {
        return
      }
      try {
        const items = await backend.ownerStudios!()
        if (alive) setCanManage(items.some((x) => x.slug === slug))
      } catch {}
    })()
    return () => {
      alive = false
    }
  }, [slug])

  if (!canManage) return null
  return (
    <button
      className="chip glass owner-entrance"
      onClick={() => {
        localStorage.setItem('pf_owner_slug', slug)
        navigate('/owner')
      }}
    >
      <Gear size={15} weight="duotone" /> Управление
    </button>
  )
}


export default function StudioApp() {
  const { slug = '' } = useParams()
  const location = useLocation()

  const { data, isLoading, error } = useQuery({
    queryKey: ['studio', slug],
    queryFn: () => backend.loadStudio(slug),
    // витрина всегда свежая: правки из кабинета (цвет, название, услуги)
    // применяются при переходе и возврате на вкладку — без перезагрузки
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  })

  // тема/акцент/префетч-хинт — общий хук (см. ui/theme.ts)
  useStudioTheme(data?.settings)

  useEffect(() => {
    if (!data) return
    document.title = `${data.settings.name} — запись на съёмку`
    const meta = document.querySelector('meta[name="robots"]')
    if (meta) meta.setAttribute('content', data.settings.status === 'demo' ? 'noindex, nofollow' : 'index, follow')
    let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'manifest'
      document.head.appendChild(link)
    }
    link.href = `/s/${slug}/manifest.webmanifest`
    let touch = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')
    if (!touch) {
      touch = document.createElement('link')
      touch.rel = 'apple-touch-icon'
      document.head.appendChild(touch)
    }
    touch.href = `/s/${slug}/icons/apple-touch-icon.png`
    // favicon вкладки — иконка студии (manifest'у она уже знакома)
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (!icon) {
      icon = document.createElement('link')
      icon.rel = 'icon'
      document.head.appendChild(icon)
    }
    icon.href = `/s/${slug}/icons/icon-192.png`
  }, [data, slug])

  if (isLoading) return <Spinner />
  if (error || !data) return <div className="center-page"><ErrorBox>Студия не найдена</ErrorBox></div>

  const s = data.settings
  const accentStyle = { '--accent': s.accent } as React.CSSProperties

  const navItems = [
    { to: `/s/${slug}`, label: 'Главная', icon: <House size={20} weight="duotone" />, end: true },
    { to: `/s/${slug}/works`, label: 'Работы', icon: <Images size={20} weight="duotone" /> },
    { to: `/s/${slug}/services`, label: 'Услуги', icon: <Tag size={20} weight="duotone" /> },
    { to: `/s/${slug}/my`, label: 'Моя запись', icon: <CalendarCheck size={20} weight="duotone" /> },
  ]

  return (
    <div style={accentStyle} className="page-with-nav">
      {s.status === 'demo' && <DemoFlag />}
      <Routes>
        <Route index element={<HomePage bundle={data} />} />
        <Route path="works" element={<WorksPage bundle={data} />} />
        <Route path="services" element={<ServicesPage bundle={data} />} />
        <Route path="book" element={<BookPage bundle={data} />} />
        <Route path="my" element={<MyBookingPage bundle={data} />} />
        <Route path="my/:token" element={<MyBookingPage bundle={data} />} />
        <Route path="policy" element={<PolicyPage />} />
      </Routes>
      <AssistantWidget slug={slug} />
      <OwnerEntrance slug={slug} />
      <nav className="bottom-nav glass" aria-label="Основная навигация">
        {navItems.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            {n.icon}
            {n.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
      {/* location используется для сброса прокрутки между страницами */}
      <span hidden>{location.key}</span>
    </div>
  )
}
