import { expect, test } from '@playwright/test'

// Поиск ближайшей открытой даты (не воскресенье — у «Кадра» это выходной)
function nextOpenDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0) d.setDate(d.getDate() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

test('студия: главная с hero и навигацией', async ({ page }) => {
  await page.goto('/s/kadr-studio')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Фотостудия «Кадр»')
  await expect(page.locator('.bottom-nav')).toBeVisible()
  await expect(page.locator('.demo-flag')).toHaveText('ОБРАЗЕЦ')
})

test('запись на съёмку: слоты, цена, заявка, моя запись', async ({ page }) => {
  await page.goto('/s/kadr-studio/book')
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Запись на съёмку')

  await page.locator('input[type="date"]').fill(nextOpenDate())
  const slots = page.locator('.slot:not([disabled])')
  await expect(slots.first()).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.slot[disabled]').first()).toBeVisible()

  await slots.first().click()

  // предварительная стоимость видна до отправки
  await expect(page.getByText('Предварительная стоимость')).toBeVisible()

  await page.locator('input[type="text"]').nth(1).fill('Тест Клиент')
  await page.locator('input[type="tel"]').fill('+7 (900) 000-00-00')
  await page.locator('input[type="checkbox"]').last().check()
  await page.getByRole('button', { name: 'Отправить заявку' }).click()

  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Заявка отправлена')

  await page.locator('section').getByRole('link', { name: 'Моя запись' }).click()
  await expect(page.getByText('Портретная съёмка').first()).toBeVisible()
})

test('галерея: лайтбокс открывается и закрывается', async ({ page }) => {
  await page.goto('/s/kadr-studio/works')
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Работы')
  await page.locator('.gallery-item img').first().click()
  await expect(page.locator('.lightbox')).toBeVisible()
  await page.locator('.lightbox .close').click()
  await expect(page.locator('.lightbox')).toHaveCount(0)
})

test('аренда студии: переключение режима и пересчёт цены', async ({ page }) => {
  await page.goto('/s/kadr-studio/book?mode=rental')
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Аренда студии')
  await page.locator('input[type="date"]').fill(nextOpenDate())
  await expect(page.locator('.slot:not([disabled])').first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(/Аренда зала · Белый зал/)).toBeVisible()
})
