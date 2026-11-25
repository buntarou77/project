import { z } from 'zod'

const envSchema = z.object({
  VITE_SUPABASE_URL: z.string().optional(), // остаётся на переходный период
  VITE_SUPABASE_ANON_KEY: z.string().optional(),
  VITE_BACKEND: z.enum(['express', 'demo']).optional(),
  VITE_API_URL: z.string().optional(), // базовый URL Express API, например https://api.example.ru
})

export const env = envSchema.parse(import.meta.env)

export const supabaseConfigured = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY)

export const apiConfigured = env.VITE_BACKEND === 'express' || (env.VITE_BACKEND !== 'demo' && Boolean(env.VITE_API_URL))
export const apiBaseUrl = (env.VITE_API_URL ?? '').replace(/\/+$/, '') // '' = относительные пути

export const APP_VERSION = '0.1.0'
export const CONSENT_VERSION = 'v1-draft'
