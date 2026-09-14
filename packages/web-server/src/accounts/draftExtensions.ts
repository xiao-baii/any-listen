import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MessageChannel, Worker } from 'node:worker_threads'

import type { ExtensionSeriveTypes } from '@any-listen/app/modules/worker/utils'
import { DEFAULT_LANG, EXTENSION } from '@any-listen/common/constants'
import defaultSetting from '@any-listen/common/defaultSetting'
import { createMessage2Call } from 'message2call'

import { extensionIds } from './publications'

const operations = new Set(['getLocalExtensionList', 'getOnlineExtensionList', 'getOnlineExtensionDetail',
  'getOnlineCategories', 'getOnlineTags', 'downloadAndParseExtension', 'installExtension', 'updateExtension',
  'enableExtension', 'disableExtension', 'uninstallExtension', 'getAllExtensionSettings',
  'getExtensionConfigValues', 'updateExtensionSettings'])

// Only one administrator exists. Its file editor never evaluates extension or source scripts.
export const createDraftExtensions = (options: {
  entry: string
  directory: string
  origins: string[]
  mirrors: () => string
  icon: (file: string) => string
}) => {
  let host: { service: ExtensionSeriveTypes; close: () => Promise<void> } | undefined
  let pending = Promise.resolve()
  let queued = 0
  let closed = false
  let idle: ReturnType<typeof setTimeout> | undefined
  const staged = new Map<string, AnyListen.Extension.Extension>()
  const start = async () => {
    if (host) return host
    const directory = options.directory
    for (const name of [EXTENSION.extDirName, EXTENSION.dataDirName, EXTENSION.tempDirName])
      await mkdir(path.join(directory, name), { recursive: true })
    const worker = new Worker(options.entry, { stdout: true, stderr: true, env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production',
      TEMP: path.join(directory, EXTENSION.tempDirName), TMP: path.join(directory, EXTENSION.tempDirName),
      ANYLISTEN_USER_ID: 'draft-editor', ANYLISTEN_ALLOWED_MEDIA_ORIGINS: JSON.stringify(options.origins),
    } })
    worker.stdout.resume()
    worker.stderr.resume()
    const { port1, port2 } = new MessageChannel()
    let resolveReady: () => void
    let rejectReady: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const rpc = createMessage2Call<ExtensionSeriveTypes>({
      exposeObj: {
        inited: () => resolveReady(), onExtensionEvent: () => {}, logger: () => {},
        createExtensionIconPublicPath: async (_dir: string, file: string) => {
          const base = await realpath(directory)
          const resolved = await realpath(file)
          if (!resolved.startsWith(base + path.sep) || !['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(path.extname(resolved)))
            throw new Error('Invalid draft icon')
          return options.icon(resolved)
        },
        removeExtensionIconPublicPath: () => {},
      }, timeout: 60_000, isSendErrorStack: false, sendMessage: data => port1.postMessage(data),
    })
    port1.on('message', data => rpc.message(data))
    const current = { service: rpc.remote, close: async () => {
      rpc.destroy(); port1.close(); await worker.terminate()
    } }
    host = current
    worker.on('error', error => rejectReady(error))
    worker.once('exit', () => {
      rpc.destroy(); port1.close(); rejectReady(new Error('Draft editor stopped'))
      if (host === current) host = undefined
    })
    worker.postMessage(port2, [port2])
    const timer = setTimeout(() => rejectReady(new Error('Draft editor startup timed out')), 30_000)
    try {
      await ready
      await rpc.remote.setExtensionState({ clientType: 'web', locale: DEFAULT_LANG, 'proxy.host': '', 'proxy.port': '',
        configFilePath: path.join(directory, EXTENSION.configFileName), extensionDir: path.join(directory, EXTENSION.extDirName),
        dataDir: path.join(directory, EXTENSION.dataDirName), tempDir: path.join(directory, EXTENSION.tempDirName),
        preloadScript: '', onlineExtensionHost: defaultSetting['extension.onlineExtensionHost'], gHMirrorHosts: options.mirrors(),
        enableDebug: false, onlineOnly: true, draftOnly: true })
      await rpc.remote.loadLocalExtensions()
      return current
    } catch (error) {
      if (host === current) host = undefined
      await current.close()
      throw error
    } finally { clearTimeout(timer) }
  }
  const stop = async () => {
    const current = host
    host = undefined
    await current?.close()
  }
  const run = <T>(action: (service: ExtensionSeriveTypes) => Promise<T>) => {
    if (closed) return Promise.reject<T>(new Error('Draft editor is closed'))
    if (queued >= 16) return Promise.reject<T>(new Error('Draft editor queue is full'))
    queued++
    clearTimeout(idle)
    const result = pending.then(async () => {
      const { service } = await start()
      await service.updateGHMirrorHosts(options.mirrors())
      return action(service)
    })
    pending = result.then(() => {}, () => {}).finally(() => {
      queued--
      if (!queued && !closed) idle = setTimeout(() => { pending = stop().catch(() => {}) }, 15_000).unref()
    })
    return result
  }
  return {
    call(name: string, args: unknown[]) {
      if (!operations.has(name)) return Promise.reject(new Error('Draft scripts run only during publication'))
      return run(async service => {
        if (name === 'downloadAndParseExtension') {
          if (typeof args[0] !== 'string' || !/^https?:\/\//.test(args[0])) throw new Error('Use an HTTP extension package URL')
          if (staged.size >= 8) throw new Error('Too many staged extension packages; reopen the player')
          const item = await service.downloadAndParseExtension(args[0], args[1] as any)
          if (!extensionIds.includes(item.id as typeof extensionIds[number])) throw new Error('Unsupported managed extension')
          const token = randomUUID()
          staged.set(token, item)
          return { ...item, directory: token }
        }
        if (name === 'installExtension' || name === 'updateExtension') {
          const token = (args[0] as { directory?: string })?.directory
          const item = token && staged.get(token)
          if (!item) throw new Error('Extension package expired')
          const result = await service[name](item)
          staged.delete(token)
          return result
        }
        if (['enableExtension', 'disableExtension', 'uninstallExtension', 'updateExtensionSettings'].includes(name) &&
          !extensionIds.includes(args[0] as typeof extensionIds[number])) throw new Error('Unsupported managed extension')
        return (service[name as keyof ExtensionSeriveTypes] as (...args: unknown[]) => Promise<unknown>)(...args)
      })
    },
    importScript(fileName: string, content: string) {
      return run(async service => {
        if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024 || !content.trim())
          throw new Error('Source script must be between 1 byte and 1 MiB')
        const header = /^\/\*[\s\S]+?\*\//.exec(content)?.[0]
        if (!header) throw new Error('Missing LX script metadata')
        const metadata: Record<string, string> = {}
        for (const line of header.split(/\r?\n/)) {
          const match = /^\s?\*\s?@(name|description|author|homepage|version)\s(.+)$/.exec(line)
          if (match) metadata[match[1]] = match[2].trim().slice(0, 1024)
        }
        const id = createHash('md5').update(content.trim()).digest('hex')
        const config = await service.getExtensionConfigValues('lx-api-source-loader', ['importedScriptSources'])
        const scripts = (config.importedScriptSources ?? []) as Array<{ id: string }>
        if (scripts.some(script => script.id === id)) throw new Error('Source script already imported')
        if (scripts.length >= 32) throw new Error('Too many source scripts')
        const item = { ...metadata, id, name: metadata.name || path.basename(fileName).slice(0, 128),
          fileName: path.basename(fileName), fileDesc: metadata.description ?? '', allowShowUpdateAlert: false }
        const directory = path.join(options.directory, EXTENSION.dataDirName, 'lx-api-source-loader', 'storage', 'scripts')
        await mkdir(directory, { recursive: true })
        await writeFile(path.join(directory, id), content)
        await service.updateExtensionSettings('lx-api-source-loader', { importedScriptSources: [...scripts, item] })
        return item
      })
    },
    importPackage(content: Buffer) {
      return run(async service => {
        const file = path.join(options.directory, EXTENSION.tempDirName, randomUUID() + '.alix')
        await writeFile(file, content)
        const item = await service.downloadAndParseExtension(file)
        if (!extensionIds.includes(item.id as typeof extensionIds[number])) throw new Error('Unsupported managed extension')
        const list = await service.getLocalExtensionList()
        return list.some(extension => extension.id === item.id) ? service.updateExtension(item) : service.installExtension(item)
      })
    },
    status() { return { workers: host ? 1 : 0, queued } },
    async close() {
      closed = true
      clearTimeout(idle)
      await pending
      await stop()
      staged.clear()
    },
  }
}
