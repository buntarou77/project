import type { Backend } from './types'
import { demoBackend } from './demo'
import { supabaseBackend } from './supabase'
import { supabaseConfigured } from '@/lib/env'

export const backend: Backend = supabaseConfigured ? supabaseBackend : demoBackend

export * from './types'
