export function toCsv(rows: Record<string, unknown>[], headers?: string[]): string {
  // П11: при пустом списке заголовки передаются явно — файл не должен быть пустым
  if (rows.length === 0) return headers?.length ? '\ufeff' + headers.join(';') : ''
  const hdrs = headers ?? Object.keys(rows[0])
  const esc = (v: unknown) => {
    let s = String(v ?? '')
    // Формула в Excel/LibreOffice начинается с = + - @: имя клиент вводит
    // в публичной форме, и такая ячейка исполнилась бы при открытии выгрузки.
    // Оборачиваем в строковый литерал — содержимое показывается текстом.
    // Телефон вида +7900… опасности не несёт и остаётся как есть.
    if (/^[@=\t\r]/.test(s) || (/^[+-]/.test(s) && !/^\+?\d[\d\s()-]*$/.test(s))) {
      s = `="${s.replace(/"/g, '""')}"`
    }
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [hdrs.join(';'), ...rows.map((r) => hdrs.map((h) => esc(r[h])).join(';'))]
  return '\ufeff' + lines.join('\n')
}

export function downloadCsv(filename: string, rows: Record<string, unknown>[], headers?: string[]) {
  const blob = new Blob([toCsv(rows, headers)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // B-46: отзыв URL сразу после click срывает скачивание (в частности в
  // Firefox) — освобождаем позже, дав браузеру начать загрузку
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
