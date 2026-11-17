import { createHash, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { config } from '../config'

export const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex')

// 32 случайных байта, base64url — для refresh/приглашений/reset/access заявок
export const randomToken = () => randomBytes(32).toString('base64url')

export function signAccess(userId: string): string {
  return jwt.sign({ sub: userId }, config.JWT_SECRET, { expiresIn: '15m', algorithm: 'HS256' })
}

export function verifyAccess(token: string): { sub: string } {
  return jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as { sub: string }
}
