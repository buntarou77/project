import { supabaseAdmin } from '../_shared/supabaseAdmin.ts'

// Доставка уведомлений владельцу из notify_outbox.
// Каналы подключаются интерфейсом: сейчас email (SMTP) и Web Push (VAPID).
// Позже добавляются MAX/VK/Telegram адаптеры отдельными каналами.

interface OutboxRow {
  id: string
  studioId: string
  channel: string
  payload: Record<string, unknown>
  status: string
}

async function deliver(row: OutboxRow): Promise<string> {
  const title = String(row.payload.title ?? 'Новая заявка')
  const text = String(row.payload.body ?? '')

  if (row.channel === 'new_booking') {
    const results: string[] = []
    const smtpUrl = Deno.env.get('SMTP_URL')
    const ownerEmail = Deno.env.get('OWNER_EMAIL')
    if (smtpUrl && ownerEmail) {
      try {
        const nodemailer = await import('npm:nodemailer@6')
        const transport = nodemailer.createTransport(smtpUrl)
        await transport.sendMail({ from: smtpUrl.match(/:\/\/([^:]+)/)?.[1] ?? 'booking@localhost', to: ownerEmail, subject: title, text })
        results.push('email:ok')
      } catch (e) {
        results.push(`email:fail:${e instanceof Error ? e.message : '?'}`)
      }
    } else results.push('email:skipped(no smtp)')

    const vpub = Deno.env.get('VAPID_PUBLIC_KEY')
    const vpriv = Deno.env.get('VAPID_PRIVATE_KEY')
    if (vpub && vpriv) {
      try {
        const webpush = await import('npm:web-push@3')
        webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:demo@example.com', vpub, vpriv)
        const { data: subs } = await supabaseAdmin().from('push_subscriptions').select('payload').eq('studioId', row.studioId)
        for (const s of (subs ?? []) as { payload: unknown }[]) {
          try {
            await webpush.sendSubscription(JSON.parse(JSON.stringify(s.payload)), JSON.stringify({ title, body: text }))
          } catch {}
        }
        results.push('webpush:ok')
      } catch (e) {
        results.push(`webpush:fail:${e instanceof Error ? e.message : '?'}`)
      }
    } else results.push('webpush:skipped(no vapid)')
    return results.join(',')
  }
  return 'unknown-channel'
}

Deno.serve(async () => {
  const { data: rows } = await supabaseAdmin()
    .from('notify_outbox')
    .select('*')
    .eq('status', 'pending')
    .limit(20)
  for (const row of (rows ?? []) as unknown as OutboxRow[]) {
    const result = await deliver(row)
    await supabaseAdmin()
      .from('notify_outbox')
      .update({ status: result.includes(':fail') ? 'failed' : 'sent', payload: { ...row.payload, result } })
      .eq('id', row.id)
  }
  return new Response(JSON.stringify({ processed: rows?.length ?? 0 }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
