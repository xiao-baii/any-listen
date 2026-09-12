import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt)
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const newToken = () => randomBytes(32).toString('base64url')
export class AccountError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}
export const fail = (status: number, message: string): never => {
  throw new AccountError(status, message)
}
export const validatePassword = (password: unknown): string => {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128)
    fail(400, 'Password must contain 12 to 128 characters')
  return password as string
}
export const hashPassword = async (password: string) => {
  validatePassword(password)
  const salt = randomBytes(16).toString('hex')
  const key = (await derive(password, salt, 64)) as Buffer
  return `${salt}:${key.toString('hex')}`
}
export const verifyPassword = async (password: unknown, encoded: string) => {
  if (typeof password !== 'string' || password.length > 128) return false
  const [salt, hash] = encoded.split(':')
  const key = (await derive(password, salt, 64)) as Buffer
  const expected = Buffer.from(hash, 'hex')
  return key.length === expected.length && timingSafeEqual(key, expected)
}
export interface Identity {
  userId: string
  sessionId: string
  role: 'admin' | 'user'
  expires: number
}
export const signIdentity = (identity: Identity, secret: string) => {
  const payload = Buffer.from(JSON.stringify(identity)).toString('base64url')
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`
}
export const verifyIdentity = (header: unknown, secret: string, userId: string): Identity | null => {
  if (typeof header !== 'string' || header.length > 2048) return null
  try {
    const [payload, signature] = header.split('.')
    const expected = createHmac('sha256', secret).update(payload).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Identity
    if (data.userId !== userId || !data.sessionId || !Number.isFinite(data.expires) || data.expires <= Date.now()) return null
    return data.role === 'admin' || data.role === 'user' ? data : null
  } catch {
    return null
  }
}
export class LoginLimiter {
  private attempts = new Map<string, { count: number; until: number }>()
  check(ip: string, username: string) {
    const now = Date.now()
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key)
    for (const key of [`ip:${ip}`, `user:${username.toLowerCase()}`]) {
      const value = this.attempts.get(key) ?? { count: 0, until: now + 15 * 60_000 }
      if (value.count >= (key.startsWith('ip:') ? 50 : 10)) fail(429, 'Too many login attempts. Try again later.')
      value.count++
      this.attempts.set(key, value)
    }
  }
}
