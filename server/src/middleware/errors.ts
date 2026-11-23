import type { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { ZodError } from 'zod'

export class ApiHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

export const badRequest = (message: string, code = 'VALIDATION') => new ApiHttpError(400, code, message)
export const forbidden = (message = 'Нет доступа') => new ApiHttpError(403, 'FORBIDDEN', message)
export const notFound = (message = 'Не найдено') => new ApiHttpError(404, 'NOT_FOUND', message)
export const conflict = (code: string, message: string) => new ApiHttpError(409, code, message)

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next)
  }
}

// Единый формат ошибок: { error: { code, message } }
export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiHttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } })
    return
  }
  // ошибка валидации тела (.parse в роутах) — это 400, а не 500.
  // Ядро схемы импортирует свой экземпляр zod, поэтому instanceof недостаточен.
  const isZodError =
    err instanceof ZodError ||
    (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'ZodError' && Array.isArray((err as ZodError).issues))
  if (isZodError) {
    const zodErr = err as ZodError
    const issue = zodErr.issues[0]
    const field = issue?.path?.join('.')
    res.status(400).json({
      error: {
        code: 'VALIDATION',
        message: field ? `${field}: ${issue?.message ?? 'некорректное значение'}` : 'Некорректное тело запроса',
      },
    })
    return
  }
  // multer: превышен лимит размера/числа файлов — ошибка клиента, а не 500
  if (err instanceof multer.MulterError) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Файл слишком большой или превышен лимит загрузки' } })
    return
  }
  console.error(err)
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } })
}
