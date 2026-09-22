import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, realpath, cp } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MessageChannel, Worker } from 'node:worker_threads'

import type { ExtensionSeriveTypes } from '@any-listen/app/modules/worker/utils'
import { logs } from '@any-listen/app/modules/logs'
import { DEFAULT_LANG, EXTENSION } from '@any-listen/common/constants'
import defaultSetting from '@any-listen/common/defaultSetting'
import { createMessage2Call } from 'message2call'

import { verifyManagedExtensions } from './extensionHealth'

type SourceService = Pick<ExtensionSeriveTypes,
  'setExtensionState' | 'loadLocalExtensions' | 'startExtensions' | 'resourceAction' |
  'getLocalExtensionList' | 'getExtensionConfigValues' | 'getExtensionLastLogs' | 'clearExtensionLogs' |
  'getResourceList' | 'getNewVersionInfo'>

export type SharedAsset = { url: string; options?: AnyListen.IPCExtension.RequestOptions; cache?: boolean } | { file: string }
export type SharedResult = { value: unknown; assets: Record<string, SharedAsset> }
const assetPrefix = 'al-ps-host:/shared/'

export class SharedExtensions {
  private host: { worker: Worker; service: SourceService; close: () => Promise<void> } | undefined
  private assets = new Map<string, SharedAsset>()
  private icons = new Map<string, SharedAsset>()
  private pending = Promise.resolve()
  private queued = 0
  private generation = 0
  private violation: string | undefined
  private directory = ''
  private version: string | undefined
  private switching: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private failure: string | undefined
  private closed = false
  onEvent: (event: SharedResult) => void = () => {}
  onFailure: () => void = () => {}

  constructor(
    private entry: string,
    private root: string,
    private logDirectory = path.join(root, 'log', 'extensions')
  ) {}

  status() {
    return { workers: this.host ? 1 : 0, version: this.version ?? null, queued: this.queued, error: this.failure ?? null }
  }

  private asset(value: SharedAsset) {
    const token = assetPrefix + randomUUID()
    this.assets.set(token, value)
    while (this.assets.size > 2048) this.assets.delete(this.assets.keys().next().value!)
    return token
  }

  private result(value: unknown): SharedResult {
    const assets: Record<string, SharedAsset> = {}
    const visit = (item: unknown) => {
      if (typeof item === 'string' && item.startsWith(assetPrefix)) {
        const asset = this.assets.get(item) ?? this.icons.get(item)
        if (!asset) throw new Error('Shared resource expired; reload the resource')
        assets[item] = asset
      } else if (Array.isArray(item)) item.forEach(visit)
      else if (item && typeof item === 'object') Object.values(item).forEach(visit)
    }
    visit(value)
    return { value, assets }
  }

  switch(version: string | undefined, directory: string, allowedOrigins: string[], mirrors: string) {
    if (this.closed) throw new Error('Public sources are shutting down')
    if (this.switching) throw new Error('Source maintenance already in progress')
    const action = this.replace(version, directory, allowedOrigins, mirrors)
    this.switching = action
    return action.finally(() => {
      if (this.switching === action) this.switching = undefined
    })
  }

  private async replace(version: string | undefined, directory: string, allowedOrigins: string[], mirrors: string) {
    await this.stop()
    this.failure = undefined
    this.violation = undefined
    if (!version) return
    const runtimeDirectory = path.join(this.root, 'source-runtime')
    try {
      await rm(runtimeDirectory, { recursive: true, force: true })
      await cp(directory, runtimeDirectory, { recursive: true })
    } catch (error) {
      this.failure = 'Public source files could not be loaded'
      throw error
    }
    directory = runtimeDirectory
    this.directory = directory
    const cache = path.join(this.root, 'source-cache')
    await rm(cache, { recursive: true, force: true })
    await mkdir(cache, { recursive: true })
    await mkdir(path.join(cache, 'temp'), { recursive: true })
    const worker = new Worker(this.entry, {
      stdout: true,
      stderr: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: cache,
        TMP: cache,
        NODE_ENV: 'production',
        ANYLISTEN_USER_ID: 'public-source',
        ANYLISTEN_ALLOWED_MEDIA_ORIGINS: JSON.stringify(allowedOrigins),
      },
    })
    // Extension diagnostics may contain administrator source credentials.
    worker.stdout.resume()
    worker.stderr.resume()
    const { port1, port2 } = new MessageChannel()
    let resolveReady: () => void
    let rejectReady: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const deny = async (name: string): Promise<never> => {
      this.violation = `Public sources cannot use personal capability: ${name}`
      throw new Error(this.violation)
    }
    const denied = Object.fromEntries(
      [
        'getPlayInfo',
        'playerAction',
        'playListAction',
        'playHistoryListAction',
        'getAllUserLists',
        'getListMusics',
        'musicListAction',
        'showInputBox',
        'showOpenBox',
        'showSaveBox',
      ].map((name) => [name, () => deny(name)])
    )
    const startupLogs: string[] = []
    let checkingStartup = true
    const rpc = createMessage2Call<SourceService>({
      exposeObj: {
        ...denied,
        inited: () => resolveReady(),
        onExtensionEvent: (event: AnyListen.IPCExtension.EventExtension) => {
          // Only public presentation data may leave the shared host.
          if (event.action === 'resourceUpdated')
            this.onEvent(this.result({ ...event, data: { ...event.data, commands: [], listProvider: [] } }))
          else if (event.action === 'logOutput') {
            if (checkingStartup && event.data.id === 'lx-api-source-loader') startupLogs.push(event.data.message)
            this.onEvent(this.result(event))
          }
        },
        createProxyUrl: (url: string, options?: AnyListen.IPCExtension.RequestOptions, cache?: boolean) =>
          this.asset({ url, options, cache }),
        checkProxyCache: () => false,
        writeProxyCache: async (name: string, data: Uint8Array) => {
          if (!(data instanceof Uint8Array) || data.byteLength > 8 * 1024 * 1024) throw new Error('Source cache entry too large')
          const ext = path.extname(name.split('?')[0]).toLowerCase()
          if (!['.mp3', '.flac', '.ogg', '.oga', '.wav', '.m4a', '.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext))
            throw new Error('Unsupported source cache type')
          const file = path.join(cache, randomUUID() + ext)
          await writeFile(file, data)
          return this.asset({ file })
        },
        createExtensionIconPublicPath: async (_dir: string, file: string) => {
          const base = await realpath(path.join(directory, 'ext'))
          const resolved = await realpath(file)
          if (
            !resolved.startsWith(base + path.sep) ||
            !['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(path.extname(resolved))
          )
            throw new Error('Invalid extension icon')
          const token = assetPrefix + randomUUID()
          if (this.icons.size >= 32) throw new Error('Too many public source icons')
          this.icons.set(token, { file: resolved })
          return token
        },
        removeExtensionIconPublicPath: () => {},
        showMessageBox: () => undefined,
        closeMessageBox: () => {},
        logger: logs.ExtensionService.logcat,
      },
      timeout: 60_000,
      isSendErrorStack: false,
      sendMessage: (data) => port1.postMessage(data),
    })
    port1.on('message', (data) => rpc.message(data))
    const host = {
      worker,
      service: rpc.remote,
      close: async () => {
        rpc.destroy()
        port1.close()
        await worker.terminate()
      },
    }
    this.host = host
    worker.on('error', (error) => {
      logs.ExtensionService.logcat.error('[Source worker] Failed', error)
      this.failure = 'Public source worker failed'
      rejectReady(new Error(this.failure))
    })
    worker.on('exit', () => {
      rpc.destroy()
      port1.close()
      rejectReady(new Error('Public source worker stopped during startup'))
      if (this.host === host) {
        this.host = undefined
        this.version = undefined
        this.failure = 'Public source worker stopped'
        this.onFailure()
      }
    })
    worker.postMessage(port2, [port2])
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Source worker startup timed out')), 30_000)
        }),
      ])
      clearTimeout(timer)
      await rpc.remote.setExtensionState({
        clientType: 'web',
        locale: DEFAULT_LANG,
        'proxy.host': '',
        'proxy.port': '',
        configFilePath: path.join(directory, EXTENSION.configFileName),
        extensionDir: path.join(directory, EXTENSION.extDirName),
        dataDir: path.join(directory, EXTENSION.dataDirName),
        logDir: this.logDirectory,
        tempDir: path.join(cache, 'temp'),
        preloadScript: await readFile(path.join(path.dirname(this.entry), 'extension-preload.js'), 'utf8'),
        onlineExtensionHost: defaultSetting['extension.onlineExtensionHost'],
        gHMirrorHosts: mirrors,
        enableDebug: false,
        onlineOnly: true,
      })
      await rpc.remote.loadLocalExtensions()
      const extensions = await rpc.remote.getLocalExtensionList()
      for (const extension of extensions) {
        if (
          extension.grant.some((grant) => grant === 'player' || grant === 'music_list') ||
          extension.contributes.listProviders?.length
        )
          throw new Error(`Public source requires personal capabilities: ${extension.id}`)
      }
      await rpc.remote.startExtensions()
      await verifyManagedExtensions(rpc.remote, startupLogs)
      checkingStartup = false
      startupLogs.length = 0
      for (let attempt = 0; ; attempt++) {
        const resources = await rpc.remote.getResourceList()
        const extensions = await rpc.remote.getLocalExtensionList()
        if (
          extensions
            .filter((e) => e.loaded)
            .every((e) =>
              (e.contributes.resource ?? []).every((r) =>
                r.resource.every((action) =>
                  resources.resources[action]?.some((item) => item.extensionId === e.id && item.id === r.id)
                )
              )
            )
        )
          break
        if (attempt === 40) throw new Error('Public source resources did not become ready')
        await delay(50)
      }
      if (this.violation) throw new Error(this.violation)
      this.version = version
    } catch (error) {
      this.failure = (error as Error).message
      await this.stop()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async call(name: string, args: unknown[], locale = DEFAULT_LANG, signal?: AbortSignal): Promise<SharedResult> {
    if (this.closed) throw new Error('Public sources are shutting down')
    if (this.switching) throw new Error('Public sources are being reloaded')
    // Account and playlist initialization stays available when public sources fail.
    if (name === 'getLocalExtensionList' && (!this.host || this.failure || this.violation)) return this.result([])
    if (name === 'getNewVersionInfo') return this.result({})
    if (name === 'getExtensionLastLogs' && !this.host) return this.result([])
    if (name === 'clearExtensionLogs' && !this.host) return this.result(undefined)
    if (name === 'getResourceList' && (!this.host || this.failure || this.violation))
      return this.result({ resources: {}, listProvider: [], commands: [] })
    if (!this.host || this.failure || this.violation)
      throw new Error(this.violation ?? this.failure ?? 'No public source is published')
    if (!['resourceAction', 'getResourceList', 'getLocalExtensionList', 'getNewVersionInfo', 'getExtensionLastLogs', 'clearExtensionLogs'].includes(name))
      throw new Error('Public source operation is forbidden')
    if (this.queued >= 128) throw new Error('Public source queue is full')
    const host = this.host,
      generation = this.generation,
      deadline = Date.now() + 30_000
    this.queued++
    const task = this.pending.then(async () => {
      if (this.host !== host || this.generation !== generation) throw new Error('Public source was replaced')
      signal?.throwIfAborted()
      if (Date.now() >= deadline) throw new Error('Public source queue wait timed out')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const value = await Promise.race([
          (host.service[name as keyof SourceService] as (...args: unknown[]) => Promise<unknown>)(...args),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              this.failure = 'Public source request timed out'
              void this.stop().then(() => this.onFailure())
              reject(new Error(this.failure))
            }, deadline - Date.now())
          }),
        ])
        if (this.violation) throw new Error(this.violation)
        signal?.throwIfAborted()
        if (name === 'getResourceList') {
          const resources = value as AnyListen.Extension.ResourceList
          resources.commands = []
          resources.listProvider = []
        }
        if (name === 'getLocalExtensionList' && locale !== DEFAULT_LANG && /^[a-z]{2}-[a-z]{2}$/.test(locale)) {
          for (const extension of value as AnyListen.Extension.Extension[]) {
            const messages = await readFile(path.join(this.directory, 'ext', extension.id, 'i18n', `${locale}.json`), 'utf8')
              .then((data) => JSON.parse(data))
              .catch(() => undefined)
            if (messages) extension.i18nMessages = { ...extension.i18nMessages, ...messages }
          }
        }
        return this.result(value)
      } finally {
        clearTimeout(timer)
      }
    })
    this.pending = task
      .then(
        () => {},
        () => {}
      )
      .finally(() => {
        this.queued--
      })
    return task
  }

  async stop() {
    if (this.stopping) return this.stopping
    this.generation++
    const host = this.host
    this.host = undefined
    this.version = undefined
    const action = (async () => {
      if (host) await host.close()
      await this.pending
      this.assets.clear()
      this.icons.clear()
    })()
    this.stopping = action
    try {
      await action
    } finally {
      if (this.stopping === action) this.stopping = undefined
    }
  }

  async close() {
    this.closed = true
    await this.switching?.catch(() => {})
    await this.stop()
  }
}
