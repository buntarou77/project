import { useEffect, useMemo, useState } from 'react'
import type { TenantSettings } from '@/core/types'

// B-45: подписка на смену системной темы; возвращает функцию отписки
export function subscribeSystemTheme(cb: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

// Тема и акцент студии на документ: общий хук для витрины и кабинета —
// иначе кабинет не перекрашивался после сохранения темы в настройках.
// Возвращает вычисленную тему ('light' | 'dark').
export function useStudioTheme(settings: TenantSettings | undefined): 'light' | 'dark' | null {
  // авто-тема следит за системой, а не читается один раз (B-45)
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )

  useEffect(
    () =>
      subscribeSystemTheme(() => {
        setSystemTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      }),
    []
  )

  const theme = useMemo(() => {
    if (!settings) return null
    if (settings.theme !== 'auto') return settings.theme
    return systemTheme
  }, [settings, systemTheme])

  useEffect(() => {
    if (!theme || !settings) return
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('pf_theme_hint', settings.theme)
    } catch {}
    const themeMeta = document.querySelector('meta[name="theme-color"]')
    if (themeMeta) themeMeta.setAttribute('content', settings.accent)
  }, [theme, settings])

  return theme
}
