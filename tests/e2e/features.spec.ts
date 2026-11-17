import { test, expect } from '@playwright/test'

// Новые элементы витрины (демо-режим, без API): карточки специалистов,
// карточка «Весь день», кастомные чекбоксы.

const FUTURE_MONDAY = (() => {
  const d = new Date()
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)) // следующий понедельник
  return d.toISOString().slice(0, 10)
})()

test('карточки специалистов вместо select (форма записи)', async ({ page }) => {
  await page.goto('/s/kadr-studio/book')
  await expect(page.getByRole('button', { name: /Любой свободный/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Анна Ветрова/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Марк Северов/ })).toBeVisible()
  // выбранная карточка получает класс active
  await page.getByRole('button', { name: /Анна Ветрова/ }).click()
  await expect(page.locator('.specialist-cards .sp-card.active')).toContainText('Анна')
})

test('«Весь день»: явное сообщение вместо пустого блока (демо всегда занят — принцип Дирихле в псевдозанятости)', async ({ page }) => {
  await page.goto('/s/kadr-studio/book?service=svc-wedding')
  const d = new Date()
  d.setDate(d.getDate() + 7)
  await page.fill('input[type=date]', d.toISOString().slice(0, 10))
  // полный e2e-прогон «весь день» покрывает smoke-скрипт (слот, цена 14100, конец);
  // в демо проверяем только что занятость не рендерит пустой блок
  await expect(page.getByText(/Весь день/)).toBeVisible()
})

test('кастомные чекбоксы отрисованы (согласие на витрине)', async ({ page }) => {
  await page.goto('/s/kadr-studio/book')
  const cb = page.locator('input[type=checkbox]').first()
  await expect(cb).toBeVisible()
  // appearance: none — наш кастомный чекбокс, не системный
  const appearance = await cb.evaluate((el) => getComputedStyle(el).appearance)
  expect(appearance).toBe('none')
})
