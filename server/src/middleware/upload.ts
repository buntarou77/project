import multer from 'multer'
import { ApiHttpError } from './errors'

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp'])

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
