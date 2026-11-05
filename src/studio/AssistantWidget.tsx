import { useState } from 'react'
import { Sparkle } from '@phosphor-icons/react'
import { backend } from '@/backend'

const PROMPTS = [
  'Когда ближайшая свободная дата на портретную съёмку?',
  'Сколько стоит love story?',
  'Что входит в пакет и когда будут фото?',
  'Как добраться?',
]

function Linkified({ text }: { text: string }) {
  const parts = text.split(/(\/s\/[a-z0-9-]+\/book\?[^\s]+|https?:\/\/[^\s]+)/g)
  return (
    <>
      {parts.map((p, i) =>
        /^(\/s\/|https?:)/.test(p) ? (
          <a key={i} href={p} style={{ color: 'inherit', fontWeight: 700 }} onClick={(e) => {
            if (p.startsWith('/s/')) {
              e.preventDefault()
              history.pushState(null, '', p)
              dispatchEvent(new PopStateEvent('popstate'))
            }
          }}>
            {p.includes('/book?') ? 'открыть форму записи' : p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

export default function AssistantWidget({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msgs, setMsgs] = useState<{ role: 'user' | 'bot'; text: string }[]>([])

  async function ask(text: string) {
    if (!text.trim() || busy) return
    setMsgs((m) => [...m, { role: 'user', text }])
    setBusy(true)
    try {
      const res = await backend.requestAssistant(slug, text, 'client')
      setMsgs((m) => [...m, { role: 'bot', text: res.reply }])
    } catch {
      setMsgs((m) => [...m, { role: 'bot', text: 'Помощник временно недоступен. Напишите владельцу в мессенджер.' }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="assistant-fab" aria-label="Помощник" onClick={() => setOpen(!open)}>
        {open ? '×' : <Sparkle size={24} weight="fill" />}
      </button>
      {open && (
        <div className="assistant-panel glass">
          <div className="assistant-msgs">
            {msgs.length === 0 && (
              <>
                <div className="assistant-msg bot">Здравствуйте! Подскажу по услугам, ценам и свободному времени этой студии.</div>
                {PROMPTS.map((p) => (
                  <button key={p} className="chip" style={{ alignSelf: 'flex-start', textAlign: 'left' }} onClick={() => ask(p)}>
                    {p}
                  </button>
                ))}
              </>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`assistant-msg ${m.role}`}>
                {m.role === 'bot' ? <Linkified text={m.text} /> : m.text}
              </div>
            ))}
            {busy && <div className="assistant-msg bot">Печатает…</div>}
          </div>
          <form
            style={{ display: 'flex', borderTop: '1px solid var(--line)' }}
            onSubmit={(e) => {
              e.preventDefault()
              const input = (e.currentTarget.elements.namedItem('q') as HTMLInputElement)
              ask(input.value)
              input.value = ''
            }}
          >
            <input
              name="q"
              placeholder="Ваш вопрос…"
              style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--ink)', padding: '12px 14px', outline: 'none' }}
            />
            <button className="btn btn-sm btn-primary" style={{ margin: 6, borderRadius: 10 }}>→</button>
          </form>
        </div>
      )}
    </>
  )
}
