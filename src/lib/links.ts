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
    case 'max': {
      // B-31: вход 'max.ru/name' без срезки домена давал https://max.ru/max.ru/name
      if (/^(https?:\/\/)?(www\.)?max\.ru\//.test(value)) {
        return 'https://max.ru/' + value.replace(/^(https?:\/\/)?(www\.)?max\.ru\//, '').replace(/^@/, '')
      }
      // прочие полные ссылки (чужой домен, max.ru без пути) не трогаем
      return value.startsWith('http') ? value : `https://max.ru/${value.replace(/^@/, '')}`
    }
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
