import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { config } from '../config'

let transport: Transporter | null = null

function getTransport(): Transporter | null {
  if (!config.SMTP_URL) return null
  if (!transport) transport = nodemailer.createTransport(config.SMTP_URL)
  return transport
}

// B5: MAIL_FROM — честный адрес отправителя; фолбэк — имя пользователя из
// SMTP_URL (декодированное, там бывает %40 вместо @), не хост.
function fromAddress(): string {
  if (config.MAIL_FROM) return config.MAIL_FROM
  if (config.SMTP_URL) {
    try {
      const u = new URL(config.SMTP_URL)
      if (u.username) return decodeURIComponent(u.username)
    } catch {
      // SMTP_URL не URL-вида — оставляем дефолт
    }
  }
  return 'booking@localhost'
}

export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const t = getTransport()
  if (!t) return false
  try {
    await t.sendMail({ from: fromAddress(), to, subject, text })
    return true
  } catch (e) {
    console.error('mail error:', e instanceof Error ? e.message : e)
    return false
  }
}
