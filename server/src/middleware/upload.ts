import multer from 'multer'
import { ApiHttpError } from './errors'

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp'])

// Сигнатуры (магические байты) изображений. mimetype в multipart декларирует
// клиент, поэтому содержимое файла проверяем по байтам, а не по заголовку.
export function sniffImageMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

// Загрузка портфолио: клиент сам сжимает (src/lib/image.ts), сервер только валидирует.
export const portfolioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      cb(new ApiHttpError(400, 'VALIDATION', 'Допустимы только jpeg/png/webp'))
      return
    }
    cb(null, true)
  },
})


// Y3: референсы клиента — приватные изображения до 5 штук, до 10 МБ каждая.
// Клиент сжимает сам (как у портфолио), сервер только валидирует.
export const referencesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      cb(new ApiHttpError(400, 'VALIDATION', 'Допустимы только jpeg/png/webp'))
      return
    }
    cb(null, true)
  },
})
