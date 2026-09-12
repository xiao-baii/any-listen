import { fork, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import type { User } from './database'
import { newToken, fail } from './security'

export interface Runtime {
  user: User
  child: ChildProcess
  port: number
  secret: string
  active: number
  lastActive: number
  busy: number
  rss: number
  stopping: boolean
  startupMs: number
}
export class Runtimes {
  entries = new Map<string, Runtime>()
  private starting = new Map<string, Promise<Runtime>>()
  private failures = new Map<string, { count: number; until: number; message: string }>()
  private stopping = new Map<string, Promise<void>>()
  private closed = false
  prepare: (user: User) => Promise<void> = async () => {}
  private maintenance: Promise<void> | undefined
  private resume: (() => void) | undefined
  async pauseStarts() {
    if (this.maintenance) fail(409, 'Maintenance already in progress')
    this.maintenance = new Promise<void>((resolve) => {
      this.resume = resolve
    })
    await Promise.allSettled(this.starting.values())
  }
  resumeStarts() {
    this.resume?.()
    this.maintenance = undefined
    this.resume = undefined
  }
  constructor(
    public root: string,
    public entry: string,
    public idleMs = 300_000
  ) {}
  allowedMediaOrigins: string[] = JSON.parse(process.env.ANYLISTEN_ALLOWED_MEDIA_ORIGINS ?? '[]')
  async get(user: User, maintenance = false): Promise<Runtime> {
    if (!maintenance) await this.maintenance
    else this.failures.delete(user.id)
    if (this.closed) fail(503, 'Account services are shutting down')
    const stop = this.stopping.get(user.id)
    if (stop) await stop
    if (this.closed) fail(503, 'Account services are shutting down')
    const current = this.entries.get(user.id)
    if (current && !current.stopping) return current
    const pending = this.starting.get(user.id)
    if (pending) return pending
    const failure = this.failures.get(user.id)
    if (failure && failure.count >= 5) fail(503, 'Account service repeatedly failed. Administrator retry required.')
    if (failure && failure.until > Date.now()) fail(503, 'Account service is restarting. Try again shortly.')
    const start = this.start(user)
      .catch(() => {
        const count = (this.failures.get(user.id)?.count ?? 0) + 1
        this.failures.set(user.id, {
          count,
          until: Date.now() + Math.min(60_000, 1000 * 2 ** count),
          message: 'Account initialization failed',
        })
        return fail(503, 'Account service failed to initialize. Try again later.')
      })
      .finally(() => this.starting.delete(user.id))
    this.starting.set(user.id, start)
    return start
  }
  private async start(user: User) {
    const startTime = performance.now()
    await this.prepare(user)
    const dataPath = path.join(this.root, 'users', user.id)
    await mkdir(dataPath, { recursive: true })
    await mkdir(path.join(dataPath, 'imports'), { recursive: true })
    await mkdir(path.join(dataPath, 'temp'), { recursive: true })
    const secret = newToken()
    const child = fork(this.entry, [], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: path.join(dataPath, 'temp'),
        TMP: path.join(dataPath, 'temp'),
        TMPDIR: path.join(dataPath, 'temp'),
        ANYLISTEN_ALLOWED_MEDIA_ORIGINS: JSON.stringify(this.allowedMediaOrigins),
        NODE_ENV: 'production',
        DATA_PATH: dataPath,
        PORT: '0',
        BIND_IP: '127.0.0.1',
        ANYLISTEN_USER_ID: user.id,
        ANYLISTEN_ROLE: user.role,
        ANYLISTEN_INTERNAL_SECRET: secret,
        ANYLISTEN_IMPORT_DIR: path.join(dataPath, 'imports'),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const runtime: Runtime = {
      user,
      child,
      secret,
      port: 0,
      active: 0,
      busy: 0,
      rss: 0,
      lastActive: Date.now(),
      stopping: false,
      startupMs: 0,
    }
    // Extension logs can contain upstream credentials; keep them in the account's own log files.
    child.stdout?.resume()
    child.stderr?.resume()
    return new Promise<Runtime>((resolve, reject) => {
      let ready = false
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, 120_000)
      child.on('message', (raw: unknown) => {
        const message = raw as { type: string; port?: number; busy?: number; rss?: number }
        if (message.type === 'ready' && message.port && !timedOut && !ready) {
          ready = true
          clearTimeout(timeout)
          runtime.port = message.port
          runtime.startupMs = Math.round(performance.now() - startTime)
          this.entries.set(user.id, runtime)
          resolve(runtime)
        } else if (message.type === 'metrics') {
          runtime.busy = message.busy ?? 0
          runtime.rss = message.rss ?? 0
          if (runtime.busy) runtime.lastActive = Date.now()
        }
      })
      child.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once('exit', (code) => {
        clearTimeout(timeout)
        if (this.entries.get(user.id) === runtime) this.entries.delete(user.id)
        if (ready && !runtime.stopping) {
          const count = (this.failures.get(user.id)?.count ?? 0) + 1
          this.failures.set(user.id, {
            count,
            until: Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(count, 6)),
            message: `Exited (${code})`,
          })
        }
        if (!ready) reject(new Error(timedOut ? 'Account startup timed out' : `Account service failed to start (${code})`))
      })
    })
  }
  async stop(id: string) {
    if (this.stopping.has(id)) return this.stopping.get(id)
    const action = this.stopOne(id).finally(() => this.stopping.delete(id))
    this.stopping.set(id, action)
    return action
  }
  private async stopOne(id: string) {
    const runtime = this.entries.get(id) ?? (await this.starting.get(id)?.catch(() => undefined))
    if (!runtime) return
    runtime.stopping = true
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => runtime.child.kill('SIGKILL'), 20_000)
      runtime.child.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`Account shutdown failed (${code})`))
      })
      if (runtime.child.connected) runtime.child.send({ type: 'shutdown' })
      else runtime.child.kill()
    })
  }
  async reap() {
    for (const [id, runtime] of this.entries) {
      if (!runtime.active && !runtime.busy && Date.now() - runtime.lastActive >= this.idleMs) await this.stop(id)
    }
  }
  retry(id: string) {
    this.failures.delete(id)
  }
  async close() {
    this.closed = true
    this.resumeStarts()
    const results = await Promise.allSettled(
      [...new Set([...this.entries.keys(), ...this.starting.keys()])].map((id) => this.stop(id))
    )
    const failed = results.find((r) => r.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
  status() {
    return {
      active: [...this.entries.values()].map((r) => ({
        userId: r.user.id,
        active: r.active,
        busy: r.busy,
        rss: r.rss,
        startupMs: r.startupMs,
        stopping: r.stopping,
      })),
      errors: [...this.failures].map(([userId, error]) => ({ userId, ...error })),
    }
  }
}
