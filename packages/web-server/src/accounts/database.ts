import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { digest, fail, hashPassword, newToken, verifyPassword } from './security'

export interface User {
  id: string
  username: string
  role: 'admin' | 'user'
  disabled: number
  mustChangePassword: number
  passwordHash: string
  createdAt: number
}
export interface Session {
  id: string
  userId: string
  expiresAt: number
  createdAt: number
  userAgent: string
  ip: string
}
export const publicUser = ({ passwordHash: _passwordHash, ...user }: User) => user
export class Accounts {
  db: Database.Database
  constructor(root: string, nativeBinding?: string) {
    mkdirSync(root, { recursive: true })
    this.db = new Database(path.join(root, 'accounts.sqlite'), nativeBinding ? { nativeBinding } : {})
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL CHECK(role IN ('admin','user')), disabled INTEGER NOT NULL DEFAULT 0, mustChangePassword INTEGER NOT NULL DEFAULT 1, passwordHash TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), tokenHash TEXT NOT NULL UNIQUE, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, userAgent TEXT NOT NULL, ip TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor TEXT, action TEXT NOT NULL, target TEXT, time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
  }
  get(id: string) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined
  }
  find(username: string) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined
  }
  list() {
    return (this.db.prepare('SELECT * FROM users ORDER BY createdAt').all() as User[]).map(publicUser)
  }
  audit(actor: string | null, action: string, target?: string) {
    this.db.prepare('INSERT INTO audit(actor,action,target,time) VALUES(?,?,?,?)').run(actor, action, target ?? null, Date.now())
  }
  async create(username: string, password: string, role: 'admin' | 'user', actor: string | null, authorize?: () => void) {
    if (typeof username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/.test(username))
      fail(400, 'Username must contain 3 to 32 letters, digits, dots, underscores or hyphens')
    if (role !== 'admin' && role !== 'user') fail(400, 'Invalid role')
    const hash = await hashPassword(password)
    authorize?.()
    if (this.find(username)) fail(409, 'Username already exists')
    const id = randomUUID()
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO users(id,username,role,passwordHash,createdAt) VALUES(?,?,?,?,?)')
        .run(id, username, role, hash, Date.now())
      this.audit(actor, 'user.create', id)
    })()
    return this.get(id)!
  }
  async login(username: string, password: string, ip: string, userAgent: string) {
    const user = this.find(username)
    const dummy = '00000000000000000000000000000000:' + '00'.repeat(64)
    const valid = await verifyPassword(password, user?.passwordHash ?? dummy)
    if (!user || user.disabled || !valid) fail(401, 'Invalid username or password')
    // Recheck after asynchronous password derivation in case an administrator changed the account.
    const current = this.get(user!.id)!
    if (current.disabled || current.passwordHash !== user!.passwordHash) fail(401, 'Invalid username or password')
    const token = newToken(),
      now = Date.now(),
      id = randomUUID()
    this.db.prepare('DELETE FROM sessions WHERE expiresAt <= ?').run(now)
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)')
      .run(id, current.id, digest(token), now + 30 * 86400_000, now, userAgent.slice(0, 512), ip)
    return { token, user: publicUser(current), session: this.session(token)!.session }
  }
  session(token: string) {
    const session = this.db
      .prepare('SELECT id,userId,expiresAt,createdAt,userAgent,ip FROM sessions WHERE tokenHash = ? AND expiresAt > ?')
      .get(digest(token), Date.now()) as Session | undefined
    if (!session) return null
    const user = this.get(session.userId)
    return user && !user.disabled ? { user, session } : null
  }
  sessions(userId: string) {
    return this.db
      .prepare('SELECT id,createdAt,expiresAt,userAgent,ip FROM sessions WHERE userId = ? AND expiresAt > ?')
      .all(userId, Date.now())
  }
  revoke(id: string, userId: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ? AND userId = ?').run(id, userId)
  }
  async password(id: string, password: string, force: boolean, actor: string, expectedHash?: string, authorize?: () => void) {
    const hash = await hashPassword(password)
    authorize?.()
    if (!this.get(id)) fail(404, 'Account not found')
    this.db.transaction(() => {
      const current = this.get(id)!
      if (expectedHash && (current.disabled || current.passwordHash !== expectedHash))
        fail(409, 'Account changed. Sign in again.')
      this.db.prepare('UPDATE users SET passwordHash = ?, mustChangePassword = ? WHERE id = ?').run(hash, Number(force), id)
      this.db.prepare('DELETE FROM sessions WHERE userId = ?').run(id)
      this.audit(actor, 'user.password', id)
    })()
  }
  disable(id: string, disabled: boolean, actor: string) {
    this.db.transaction(() => {
      const user = this.get(id)
      if (!user) fail(404, 'Account not found')
      if (disabled && user!.role === 'admin') {
        const { count } = this.db
          .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?")
          .get(id) as { count: number }
        if (!count) fail(409, 'Cannot disable the last administrator')
      }
      this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(Number(disabled), id)
      if (disabled) this.db.prepare('DELETE FROM sessions WHERE userId = ?').run(id)
      this.audit(actor, disabled ? 'user.disable' : 'user.enable', id)
    })()
  }
  state(key: string) {
    return (this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined)?.value
  }
  setState(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run(key, value)
  }
  close() {
    this.db.close()
  }
}
