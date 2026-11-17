import type { Backend } from './types'
import { demoBackend } from './demo'
import { supabaseBackend } from './supabase'
import { expressBackend } from './express'
import { supabaseConfigured, apiConfigured } from '@/lib/env'

// Приоритет: Express → Supabase (переходный период) → демо.
export const backend: Backend = apiConfigured
  ? expressBackend
  : supabaseConfigured
    ? supabaseBackend
    : demoBackend

export * from './types'
