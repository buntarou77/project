import { z } from 'zod'

const envSchema = z.object({
  VITE_SUPABASE_URL: z.string().optional(),
  VITE_SUPABASE_ANON_KEY: z.string().optional(),
})

export const env = envSchema.parse(import.meta.env)

export const supabaseConfigured = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY)

export const APP_VERSION = '0.1.0'
export const CONSENT_VERSION = 'v1-draft'
