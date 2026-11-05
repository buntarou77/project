import { expect, test } from '@playwright/test'

test('вход владельца и разделы кабинета', async ({ page }) => {
  await page.goto('/owner')
  await page.locator('input[type="email"]').fill('owner@example.com')
  await page.locator('input[type="password"]').fill('demo')
  await page.getByRole('button', { name: 'Войти' }).click()

  await expect(page.getByRole('heading', { level: 2 })).toContainText('Фотостудия «Кадр»')
  await expect(page.getByRole('button', { name: 'Экспорт CSV' })).toBeVisible()
  await expect(page.getByText('+ Добавить вручную')).toBeVisible()

  await page.getByRole('link', { name: 'Календарь' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Фотостудия «Кадр»' })).toBeVisible()

  await page.getByRole('link', { name: 'Статистика' }).click()
  await expect(page.getByText('Заявки', { exact: true }).first()).toBeVisible()
})

test('выбор студии в кабинете переключает данные', async ({ page }) => {
  await page.goto('/owner')
  await page.locator('input[type="email"]').fill('owner@example.com')
  await page.locator('input[type="password"]').fill('demo')
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByRole('heading', { level: 2 })).toContainText('Фотостудия «Кадр»')
  await page.locator('select.chip').selectOption('anna-vetrova')
  await expect(page.getByRole('heading', { level: 2 })).toContainText('Анна Ветрова')
})
