import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  UPLOADS_DIR: z.string().default('./uploads'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET должен быть не короче 32 символов'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  DAILY_MODEL_BUDGET_RUB: z.coerce.number().default(50),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().optional(), // адрес отправителя, напр. noreply@example.ru
  OWNER_EMAIL: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  TRUST_PROXY: z.string().optional().transform((v) => v === 'true' || v === '1'),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Некорректные переменные окружения:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config = parsed.data
export const isProd = config.NODE_ENV === 'production'
