import { defineConfig } from 'vitest/config'

// Интеграционные тесты API: реальный Postgres через TEST_DATABASE_URL.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // два integration-файла по очереди поднимают embedded PG на одном порту
    fileParallelism: false,
  },
})
