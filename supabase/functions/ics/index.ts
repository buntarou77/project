function esc(s: string): string {
  return s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n')
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function event(b: Record<string, unknown>, studioName: string): string {
  const startMs = new Date(b.startsAt as string).getTime()
  const endMs = new Date(b.endsAt as string).getTime()
  return [
    'BEGIN:VEVENT',
    `UID:${b.id}@booking`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(startMs)}`,
    `DTEND:${stamp(endMs)}`,
    `SUMMARY:${esc(`${b.serviceName} — ${studioName}`)}`,
    `STATUS:${['cancelled_by_client', 'rejected', 'no_show'].includes(b.status as string) ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
  ].join('\r\n')
}

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const slug = url.searchParams.get('slug')
  const token = url.searchParams.get('token')
  if (!slug || !token) return new Response('bad request', { status: 400 })

  const { createClient } = await import('npm:@supabase/supabase-js@2')
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: studio } = await sb.from('studios').select('settings, "calendarToken"').eq('slug', slug).single()
  if (!studio) return new Response('not found', { status: 404 })
  const studioName = ((studio.settings as { name: string }).name) ?? slug

  const calToken = (studio as { calendarToken: string }).calendarToken
  let body: string
  if (token === calToken) {
    // лента владельца: все будущие активные записи (только чтение)
    const { data: rows } = await sb
      .from('bookings')
      .select('*')
      .eq('slug', slug)
      .gte('startsAt', new Date().toISOString())
    const events = ((rows ?? []) as Record<string, unknown>[]).map((b) => event(b, studioName)).join('\r\n')
    body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//photo-booking-platform//RU\r\nX-WR-CALNAME:${esc(studioName)}\r\n${events}\r\nEND:VCALENDAR`
  } else {
    // одна запись клиента по секретному токену
    const { data: b } = await sb.from('bookings').select('*').eq('"accessToken"', token).eq('slug', slug).single()
    if (!b) return new Response('not found', { status: 404 })
    body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//photo-booking-platform//RU\r\n${event(b as Record<string, unknown>, studioName)}\r\nEND:VCALENDAR`
  }

  return new Response(body, {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  })
})
