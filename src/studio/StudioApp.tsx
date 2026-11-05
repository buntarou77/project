import { useEffect, useMemo } from 'react'
import { NavLink, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { House, Images, Tag, CalendarCheck } from '@phosphor-icons/react'
import { backend } from '@/backend'
import { DemoFlag, ErrorBox, Spinner } from '@/ui/common'
import HomePage from './HomePage'
import WorksPage from './WorksPage'
import ServicesPage from './ServicesPage'
import BookPage from './BookPage'
import MyBookingPage from './MyBookingPage'
import PolicyPage from './PolicyPage'
import AssistantWidget from './AssistantWidget'
import { getLastToken } from './bookingStorage'


export default function StudioApp() {
  const { slug = '' } = useParams()
  const location = useLocation()

  const { data, isLoading, error } = useQuery({
    queryKey: ['studio', slug],
    queryFn: () => backend.loadStudio(slug),
  })

  const theme = useMemo(() => {
    if (!data) return 'light'
    if (data.settings.theme !== 'auto') return data.settings.theme
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }, [data])

  useEffect(() => {
    if (!data) return
    document.title = `${data.settings.name} — запись на съёмку`
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('pf_theme_hint', data.settings.theme)
    } catch {}
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
    const themeMeta = document.querySelector('meta[name="theme-color"]')
    if (themeMeta) themeMeta.setAttribute('content', s.accent)
  }, [data, theme, slug])

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
