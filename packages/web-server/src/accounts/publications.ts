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
  private candidate: string | undefined
  private message = ''
  constructor(
    private accounts: Accounts,
    private runtimes: Runtimes
  ) {}
  status() {
    return { version: this.accounts.state('publication') ?? null, running: this.running, message: this.message }
  }
  async apply(user: User) {
    // The administrator's directory is the editable draft; ordinary accounts receive immutable releases.
    if (user.role === 'admin') return
    const version = this.candidate ?? this.accounts.state('publication')
    const root = path.join(this.runtimes.root, 'users', user.id, 'app', 'extension')
    const current = await readFile(path.join(root, 'managed-version'), 'utf8').catch(() => '')
    if (!version) {
      // Recover an interrupted first publication without exposing the uncommitted release.
      for (const id of extensionIds) {
        await rm(path.join(root, 'ext', id), { recursive: true, force: true })
        await rm(path.join(root, 'datas', id, 'configuration.json'), { force: true })
        await rm(path.join(root, 'datas', id, 'storage', 'scripts'), { recursive: true, force: true })
      }
      await mkdir(root, { recursive: true })
      await writeFile(path.join(root, 'extensions.json'), '[]')
      await rm(path.join(root, 'managed-version'), { force: true })
      return
    }
    if (current === version) return
    const source = path.join(this.runtimes.root, 'publications', version)
    await mkdir(root, { recursive: true })
    await rm(path.join(root, 'managed-version'), { force: true })
    for (const id of extensionIds) {
      for (const dir of ['ext', 'datas']) {
        const target = path.join(root, dir, id)
        // Only the managed extensions are replaced; unrelated account data is never copied or removed.
        if (dir === 'ext') await rm(target, { recursive: true, force: true })
        await mkdir(path.dirname(target), { recursive: true })
        if (dir === 'datas') await rm(path.join(target, 'storage', 'scripts'), { recursive: true, force: true })
        await safeCopy(path.join(source, dir, id), target)
      }
    }
    await cp(path.join(source, 'extensions.json'), path.join(root, 'extensions.json'))
    await writeFile(path.join(root, 'managed-version'), version)
  }
  async publish(admin: User) {
    if (this.running) fail(409, 'A publication is already running')
    this.running = true
    this.message = 'Validating extension snapshot'
    const previous = this.accounts.state('publication')
    const version = randomUUID()
    const target = path.join(this.runtimes.root, 'publications', version)
    let active: User[] = []
    const validatorId = randomUUID()
    const validator = { ...admin, id: validatorId, role: 'user' as const }
    const check = new Runtimes(this.runtimes.root, this.runtimes.entry)
    check.allowedMediaOrigins = this.runtimes.allowedMediaOrigins
    try {
      await this.runtimes.pauseStarts()
      active = [...this.runtimes.entries.values()].map((r) => r.user).filter((u) => u.role !== 'admin')
      await this.runtimes.stop(admin.id)
      await snapshotExtensions(path.join(this.runtimes.root, 'users', admin.id, 'app', 'extension'), target)
      this.candidate = version
      check.prepare = (user) => this.apply(user)
      await check.get(validator)
      await check.close()
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
      this.candidate = previous
      // Include accounts that started while the rollout was in progress.
      const affected = new Map(
        [...active, ...[...this.runtimes.entries.values()].map((r) => r.user)]
          .filter((u) => u.role !== 'admin')
          .map((u) => [u.id, u])
      )
      const rollbackErrors: string[] = []
      for (const user of affected.values()) {
        try {
          await this.runtimes.stop(user.id)
          if (!previous) {
            const root = path.join(this.runtimes.root, 'users', user.id, 'app', 'extension')
            for (const id of extensionIds) await rm(path.join(root, 'ext', id), { recursive: true, force: true })
            await writeFile(path.join(root, 'extensions.json'), '[]')
            await rm(path.join(root, 'managed-version'), { force: true })
          }
          await this.runtimes.get(user, true)
        } catch {
          rollbackErrors.push(user.username)
        }
      }
      this.message = `Publication failed: ${(error as Error).message}${rollbackErrors.length ? `. Rollback needs retry: ${rollbackErrors.join(', ')}` : ''}`
      this.accounts.audit(admin.id, 'extension.publish.failed', version)
      fail(400, this.message)
    } finally {
      try {
        await check.close()
        await rm(path.join(this.runtimes.root, 'users', validatorId), { recursive: true, force: true })
      } finally {
        this.candidate = undefined
        this.running = false
        this.runtimes.resumeStarts()
      }
    }
  }
}
