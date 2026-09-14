import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import defaultSetting from '@any-listen/common/defaultSetting'
import { getNativeName } from '@any-listen/nodejs'
import { configurePublicNetwork } from '@any-listen/nodejs/request'

import type { User } from './database'
import { newToken, fail } from './security'
import { SharedDatabase } from './sharedDatabase'
import { SharedExtensions } from './sharedExtensions'
import type { DBSeriveTypes } from '@any-listen/app/modules/worker/utils'
import type { createAccountContext } from './context'

export interface Runtime {
  user: User
  child?: never
  context: Awaited<ReturnType<typeof createAccountContext>>
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
  readonly sources: SharedExtensions
  private database: SharedDatabase | undefined
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
  ) {
    configurePublicNetwork(this.allowedMediaOrigins)
    this.sources = new SharedExtensions(path.join(path.dirname(entry), 'extension-service.worker.js'), root)
    this.sources.onEvent = (data) => {
      for (const runtime of this.entries.values()) {
        if (runtime.stopping) continue
        if (runtime.context) void runtime.context.sourceEvent(data).catch(() => {})
      }
    }
  }
  private mediaOrigins: string[] = JSON.parse(process.env.ANYLISTEN_ALLOWED_MEDIA_ORIGINS ?? '[]')
  get allowedMediaOrigins() { return this.mediaOrigins }
  set allowedMediaOrigins(origins: string[]) {
    this.mediaOrigins = origins
    configurePublicNetwork(origins)
  }
  proxyAllResources = false
  onlineResourceEnabled = false
  ghMirrorHosts = defaultSetting['extension.ghMirrorHosts']
  setSiteSettings(settings: { proxyAllResources: boolean; onlineResourceEnabled: boolean; ghMirrorHosts: string }) {
    this.proxyAllResources = settings.proxyAllResources
    this.onlineResourceEnabled = settings.onlineResourceEnabled
    this.ghMirrorHosts = settings.ghMirrorHosts
    for (const runtime of this.entries.values()) {
      if (runtime.stopping) continue
      if (runtime.context) runtime.context.updateSite(settings)
    }
  }
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
    {
      this.database ??= new SharedDatabase(path.join(path.dirname(this.entry), 'accounts-db.worker.js'))
      const appPath = path.join(dataPath, 'app')
      await mkdir(appPath, { recursive: true })
      const channel = await this.database.open(appPath,
        path.join(path.dirname(this.entry), '../native', getNativeName(), 'better_sqlite3.node'), user.id)
      try {
        const { createAccountContext } = await import('./context')
        const context = await createAccountContext({ id: user.id, directory: dataPath, secret,
          database: channel.service as DBSeriveTypes, sources: this.sources, role: user.role,
          workerEntry: path.join(path.dirname(this.entry), 'extension-service.worker.js'), allowedOrigins: this.allowedMediaOrigins,
          site: { proxyAllResources: this.proxyAllResources, onlineResourceEnabled: this.onlineResourceEnabled, ghMirrorHosts: this.ghMirrorHosts } })
        context.updateSite({ proxyAllResources: this.proxyAllResources, onlineResourceEnabled: this.onlineResourceEnabled, ghMirrorHosts: this.ghMirrorHosts })
        const runtime: Runtime = { user, context, secret, port: context.port, active: 0, lastActive: Date.now(),
          get busy() { return context.busy }, rss: 0, stopping: false, startupMs: Math.round(performance.now() - startTime) }
        const closeContext = context.close
        context.close = async () => {
          try { await closeContext() } finally { await channel.close() }
        }
        this.entries.set(user.id, runtime)
        void channel.closed.catch(() => {
          void this.stop(user.id).catch(() => {})
          const count = (this.failures.get(user.id)?.count ?? 0) + 1
          this.failures.set(user.id, { count, until: Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(count, 6)), message: 'Database worker failed' })
        })
        return runtime
      } catch (error) {
        await channel.close()
        throw error
      }
    }
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
    if (runtime.context) {
      try { await runtime.context.close() }
      finally { if (this.entries.get(id) === runtime) this.entries.delete(id) }
      return
    }
  }

  async reap() {
    for (const [id, runtime] of this.entries) {
      if (runtime.busy) runtime.lastActive = Date.now()
      if (!runtime.active && !runtime.busy && Date.now() - runtime.lastActive >= this.idleMs) await this.stop(id)
    }
  }
  retry(id: string) {
    this.failures.delete(id)
  }
  async close() {
    this.closed = true
    this.resumeStarts()
    await this.sources.close()
    const results = await Promise.allSettled(
      [...new Set([...this.entries.keys(), ...this.starting.keys()])].map((id) => this.stop(id))
    )
    const failed = results.find((r) => r.status === 'rejected')
    await this.database?.close()
    if (failed?.status === 'rejected') throw failed.reason
  }
  status() {
    return {
      topology: 'single-process-shared-workers',
      gatewayRss: process.memoryUsage().rss,
      database: this.database?.status() ?? { workers: 0, channels: 0 },
      sources: this.sources.status(),
      draftWorkers: [...this.entries.values()].reduce((sum, runtime) => sum + (runtime.context?.draftStatus().workers ?? 0), 0),
      active: [...this.entries.values()].map((r) => ({
        userId: r.user.id,
        active: r.active,
        busy: r.busy,
        rss: r.rss,
        process: process.pid,
        startupMs: r.startupMs,
        stopping: r.stopping,
      })),
      errors: [...this.failures].map(([userId, error]) => ({ userId, ...error })),
    }
  }
}
