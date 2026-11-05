import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

let admin: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!admin) {
    const url = Deno.env.get('SUPABASE_URL')!
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    admin = createClient(url, key, { auth: { persistSession: false } })
  }
  return admin
}
