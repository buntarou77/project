import type { PortfolioItem, TenantSettings } from '@/core/types'

export interface HeroImage {
  src: string
  srcset?: string
}

// Фото шапки витрины. Приоритет: своё фото владельца (heroPhotoUrl) → работа,
// выбранная в настройках (heroPhotoId) → первый «интерьер студии» → первая работа.
// null — работ нет, показываем заглушку-градиент.
export function heroImageFor(settings: TenantSettings, portfolio: PortfolioItem[]): HeroImage | null {
  // пустая строка/null из старого JSON — как «не задано»
  if (settings.heroPhotoUrl) return { src: settings.heroPhotoUrl }
  const item =
    portfolio.find((p) => p.id === settings.heroPhotoId) ??
    portfolio.find((p) => p.category === 'интерьер студии') ??
    portfolio[0]
  return item ? { src: item.src, srcset: item.srcset } : null
}
