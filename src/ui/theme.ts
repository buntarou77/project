import { useEffect, useMemo } from 'react'
import type { TenantSettings } from '@/core/types'

// Тема и акцент студии на документ: общий хук для витрины и кабинета —
// иначе кабинет не перекрашивался после сохранения темы в настройках.
// Возвращает вычисленную тему ('light' | 'dark').
export function useStudioTheme(settings: TenantSettings | undefined): 'light' | 'dark' | null {
  const theme = useMemo(() => {
    if (!settings) return null
    if (settings.theme !== 'auto') return settings.theme
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }, [settings])

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
