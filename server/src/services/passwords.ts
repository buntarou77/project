import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import bcrypt from 'bcryptjs'

// §5.1: новые хеши — Argon2id; bcrypt из Supabase валиден при логине и
// немедленно перехешируется.

export function hashPassword(password: string): Promise<string> {
  return argonHash(password)
}

export async function verifyPassword(
  hash: string,
  password: string
): Promise<{ ok: boolean; rehashToArgon?: string }> {
  if (hash.startsWith('$2')) {
    const ok = await bcrypt.compare(password, hash)
    return { ok, rehashToArgon: ok ? await argonHash(password) : undefined }
  }
  return { ok: await argonVerify(hash, password) }
}
