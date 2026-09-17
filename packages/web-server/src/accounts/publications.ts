import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { Accounts, User } from './database'
import { Runtimes } from './runtime'
import { fail } from './security'

export const extensionIds = ['online-metadata', 'lx-api-source-loader'] as const
const readJSON = async (file: string) => JSON.parse(await readFile(file, 'utf8'))
export const safeCopy = async (source: string, target: string) => {
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed in managed data')
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true })
    for (const name of await readdir(source)) await safeCopy(path.join(source, name), path.join(target, name))
  } else if (info.isFile()) await cp(source, target)
  else throw new Error('Unsupported file type')
}
export const snapshotExtensions = async (source: string, target: string) => {
  await mkdir(target, { recursive: true })
  const settings = (await readJSON(path.join(source, 'extensions.json'))) as Array<{ id: string; enabled: boolean }>
  const selected = settings
    .filter((item) => extensionIds.includes(item.id as (typeof extensionIds)[number]))
    .map(({ id, enabled }) => ({ id, enabled }))
  if (
    new Set(selected.map((s) => s.id)).size !== 2 ||
    selected.length !== 2 ||
    selected.some((s) => typeof s.enabled !== 'boolean')
  )
    fail(400, 'Install both managed extensions before publishing')
  for (const id of extensionIds) {
    const packages = await readdir(path.join(source, 'ext'))
    const matches: string[] = []
    for (const name of packages) {
      const manifest = await readJSON(path.join(source, 'ext', name, 'manifest.json')).catch(() => null)
      if (manifest?.id === id) matches.push(name)
    }
    if (matches.length !== 1) fail(400, `Expected exactly one installed version of ${id}`)
    const packagePath = path.join(source, 'ext', matches[0])
    const manifest = await readJSON(path.join(packagePath, 'manifest.json'))
    if (manifest.id !== id) fail(400, 'Extension manifest does not match its directory')
    if (
      manifest.grant?.some((grant: string) => ['player', 'music_list'].includes(grant)) ||
      manifest.contributes?.listProviders?.length
    )
      fail(400, `Public source requires personal capabilities: ${id}`)
    await safeCopy(packagePath, path.join(target, 'ext', id))
    const configPath = path.join(source, 'datas', id, 'configuration.json')
    const config = await readJSON(configPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return {}
      throw error
    })
    if (!config || typeof config !== 'object' || Array.isArray(config)) fail(400, `Invalid configuration for ${id}`)
    await mkdir(path.join(target, 'datas', id), { recursive: true })
    await writeFile(path.join(target, 'datas', id, 'configuration.json'), JSON.stringify(config))
    if (id === 'lx-api-source-loader') {
      const scripts = config.importedScriptSources ?? []
      if (!Array.isArray(scripts) || !Array.isArray(config.enabledScripts ?? [])) fail(400, 'Invalid source configuration')
      const ids = scripts.map((item: { id: string }) => item.id)
      if (ids.some((value: unknown) => typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value as string)))
        fail(400, 'Invalid script identifier')
      if (new Set(ids).size !== ids.length) fail(400, 'Duplicate script identifier')
      if ((config.enabledScripts ?? []).some((id: string) => !ids.includes(id))) fail(400, 'Enabled script is missing')
      if (selected.find((s) => s.id === id)?.enabled && !(config.enabledScripts ?? []).length)
        fail(400, 'Enable at least one LX source script before publishing')
      await mkdir(path.join(target, 'datas', id, 'storage', 'scripts'), { recursive: true })
      for (const scriptId of ids)
        await safeCopy(
          path.join(source, 'datas', id, 'storage', 'scripts', scriptId),
          path.join(target, 'datas', id, 'storage', 'scripts', scriptId)
        )
    }
  }
  await writeFile(path.join(target, 'extensions.json'), JSON.stringify(selected))
}
export class Publications {
  private running = false
  private loading: Promise<void> | undefined
  private initialized = false
  private message = ''
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined
  private recoveryAttempts = 0
  private recovery: Promise<void> | undefined
  private closed = false
  constructor(
    private accounts: Accounts,
    private runtimes: Runtimes
  ) {
    runtimes.sources.onFailure = () => this.scheduleRecovery()
  }
  private scheduleRecovery() {
    if (this.closed || this.running || this.recoveryTimer || !this.accounts.state('publication')) return
    if (this.recoveryAttempts >= 3) {
      this.message = 'Public source recovery failed; administrator retry required'
      return
    }
    const wait = 1000 * 2 ** this.recoveryAttempts++
    this.message = 'Public source restarting'
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined
      this.recovery = this.retrySources(true).catch(() => this.scheduleRecovery())
    }, wait).unref()
  }
  async close() {
    this.closed = true
    clearTimeout(this.recoveryTimer)
    this.runtimes.sources.onFailure = () => {}
    await this.recovery
  }
  status() {
    return { version: this.accounts.state('publication') ?? null, running: this.running, message: this.message }
  }
  async apply(user: User) {
    // Every player's resources come from the published version, including the administrator.
    if (this.initialized) return
    this.loading ??= this.loadPublished()
      .catch(() => {
        // Failed sources are reported by the host; personal music data remains usable.
        this.initialized = true
      })
      .finally(() => {
        this.loading = undefined
      })
    await this.loading
  }
  async retrySources(automatic = false) {
    if (this.running) fail(409, 'A publication is already running')
    this.running = true
    clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
    if (!automatic) this.recoveryAttempts = 0
    try {
      await this.runtimes.pauseStarts()
      await this.loading
      const active = [...this.runtimes.entries.values()]
        .map((runtime) => runtime.user)
      await this.runtimes.sources.stop()
      for (const user of active) await this.runtimes.stop(user.id)
      await this.loadPublished()
      for (const user of active) await this.runtimes.get(user, true)
      this.message = 'Public sources restored'
    } finally {
      this.running = false
      this.runtimes.resumeStarts()
    }
  }
  private async loadPublished() {
    const version = this.accounts.state('publication')
    await this.runtimes.sources.switch(
      version,
      path.join(this.runtimes.root, 'publications', version ?? 'unpublished'),
      this.runtimes.allowedMediaOrigins,
      this.runtimes.ghMirrorHosts
    )
    this.initialized = true
  }
  async publish(admin: User) {
    if (this.running) fail(409, 'A publication is already running')
    this.running = true
    clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
    this.recoveryAttempts = 0
    this.message = 'Validating extension snapshot'
    const previous = this.accounts.state('publication')
    const version = randomUUID()
    const target = path.join(this.runtimes.root, 'publications', version)
    let active: User[] = []
    try {
      await this.runtimes.pauseStarts()
      active = [...this.runtimes.entries.values()].map((r) => r.user)
      await this.runtimes.stop(admin.id)
      await snapshotExtensions(path.join(this.runtimes.root, 'users', admin.id, 'app', 'extension'), target)
      await this.runtimes.sources.stop()
      for (const user of active) await this.runtimes.stop(user.id)
      await this.runtimes.sources.switch(version, target, this.runtimes.allowedMediaOrigins, this.runtimes.ghMirrorHosts)
      this.initialized = true
      for (const user of active) {
        this.message = `Applying to ${user.username}`
        try {
          await this.runtimes.stop(user.id)
          await this.runtimes.get(user, true)
        } catch (error) {
          throw new Error(`${user.username}: ${(error as Error).message}`)
        }
      }
      this.accounts.db.transaction(() => {
        this.accounts.setState('publication', version)
        this.accounts.audit(admin.id, 'extension.publish', version)
      })()
      this.message = 'Published'
    } catch (error) {
      // Include accounts that started while the rollout was in progress.
      const affected = new Map(
        [...active, ...[...this.runtimes.entries.values()].map((r) => r.user)]
          .map((u) => [u.id, u])
      )
      const rollbackErrors: string[] = []
      await this.runtimes.sources.stop()
      for (const user of affected.values()) {
        try {
          await this.runtimes.stop(user.id)
        } catch {
          rollbackErrors.push(user.username)
        }
      }
      try {
        await this.runtimes.sources.switch(
          previous,
          path.join(this.runtimes.root, 'publications', previous ?? 'unpublished'),
          this.runtimes.allowedMediaOrigins,
          this.runtimes.ghMirrorHosts
        )
        this.initialized = true
      } catch {
        rollbackErrors.push('public sources')
      }
      for (const user of affected.values()) {
        try {
          await this.runtimes.stop(user.id)
          await this.runtimes.get(user, true)
        } catch {
          rollbackErrors.push(user.username)
        }
      }
      this.message = `Publication failed: ${(error as Error).message}${rollbackErrors.length ? `. Rollback needs retry: ${rollbackErrors.join(', ')}` : ''}`
      this.accounts.audit(admin.id, 'extension.publish.failed', version)
      fail(400, this.message)
    } finally {
      // The host runs a copy in source-runtime; only the committed snapshot is needed for recovery.
      try {
        const directory = path.join(this.runtimes.root, 'publications')
        const current = this.accounts.state('publication')
        const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []
          throw error
        })
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== current)
            await rm(path.join(directory, entry.name), { recursive: true, force: true })
        }
      } catch (error) {
        this.message += `. Snapshot cleanup failed: ${(error as Error).message}`
      }
      this.running = false
      this.runtimes.resumeStarts()
    }
  }
}
