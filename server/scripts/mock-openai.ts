// Мок OpenAI API для локального тестирования помощника без реального ключа.
// Запуск: pnpm mock:openai   (порт 3100, в .env: OPENAI_BASE_URL=http://localhost:3100/v1, OPENAI_API_KEY=mock)
import http from 'node:http'

const port = Number(process.env.MOCK_OPENAI_PORT ?? 3100)

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url?.includes('/chat/completions')) {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}')
        const asked = parsed.messages?.some((m: { role: string; content?: string }) =>
          m.role === 'user' && /цен|стоим|стоит|дорог/i.test(m.content ?? '')
        )
        const reply = asked
          ? 'Мок-помощник: цены смотрите в разделе «Услуги» — там же кнопка записи.'
          : 'Мок-помощник: я работаю! Смотрите свободное время в форме записи или напишите владельцу в Telegram.'
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            id: 'mock-' + Date.now(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: parsed.model ?? 'mock',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: reply },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          })
        )
      } catch {
        res.statusCode = 400
        res.end('{}')
      }
    })
    return
  }
  res.statusCode = 404
  res.end('{}')
})

server.listen(port, () => {
  console.log(`mock OpenAI: http://localhost:${port}/v1 (POST /chat/completions)`)
})
