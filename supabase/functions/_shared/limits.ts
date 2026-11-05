import { supabaseAdmin } from './supabaseAdmin.ts'

export async function rateLimit(key: string, limit: number, windowSec = 60): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / (windowSec * 1000)) * windowSec * 1000).toISOString()
  const { data, error } = await supabaseAdmin().rpc('increment_rate_limit', { p_key: key, p_window: windowStart })
  if (error) return true // не блокируем из-за сбоя лимитера
  return (data as number) <= limit
}

export async function assistantBudgetOk(studioId: string, dailyLimitRequests: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabaseAdmin()
    .from('assistant_usage')
    .upsert({ studioId, day, requests: 1 }, { onConflict: 'studioId,day', ignoreDuplicates: false })
    .select()
    .single()
  if (error || !data) return true
  return (data as { requests: number }).requests <= dailyLimitRequests
}
