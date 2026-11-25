import type { Backend } from './types'
import { demoBackend } from './demo'
import { expressBackend } from './express'
import { apiConfigured } from '@/lib/env'

// Supabase сохранён для переноса данных, но не доступен через приложение.
export const backend: Backend = apiConfigured ? expressBackend : demoBackend

export * from './types'
