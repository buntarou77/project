export function contactHref(type: string, value: string): string {
  switch (type) {
    case 'phone':
      return `tel:${value.replace(/[^+\d]/g, '')}`
    case 'telegram':
      return value.startsWith('http') ? value : `https://t.me/${value.replace('@', '')}`
    case 'whatsapp':
      return value.startsWith('http') ? value : `https://wa.me/${value.replace(/\D/g, '')}`
    case 'vk':
      return value.startsWith('http') ? value : `https://vk.com/${value}`
    default:
      return value
  }
}

export const CONTACT_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'ВКонтакте',
  max: 'MAX',
  phone: 'Позвонить',
}
