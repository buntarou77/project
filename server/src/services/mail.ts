import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import { config } from '../config'

let transport: Transporter | null = null

function getTransport(): Transporter | null {
  if (!config.SMTP_URL) return null
  if (!transport) transport = nodemailer.createTransport(config.SMTP_URL)
  return transport
}

export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const t = getTransport()
  if (!t) return false
  try {
    const from = config.SMTP_URL?.match(/:\/\/([^:]+)/)?.[1] ?? 'booking@localhost'
    await t.sendMail({ from, to, subject, text })
    return true
  } catch (e) {
    console.error('mail error:', e instanceof Error ? e.message : e)
    return false
  }
}
