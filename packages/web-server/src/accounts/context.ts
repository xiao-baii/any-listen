import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { createDislikeList } from '@any-listen/app/modules/dislikeList/service'
import { appLogEvent, logs } from '@any-listen/app/modules/logs'
import { createMusicList } from '@any-listen/app/modules/musicList/service'
import { createOnlineListSync } from '@any-listen/app/modules/musicList/onlineSync'
import { createProxyService } from '@any-listen/app/modules/proxyServer'
import { clearCache, getCacheSize } from '@any-listen/app/modules/proxyServer/shared'
import { createResources } from '@any-listen/app/modules/resources/service'
import type { DBSeriveTypes, ExtensionSeriveTypes, UtilSeriveTypes } from '@any-listen/app/modules/worker/utils'
import { createCache } from '@any-listen/common/cache'
import { API_PREFIX, DEFAULT_LANG, PROXY_SERVER_PATH, PROXY_URL_PATH, STORE_NAMES } from '@any-listen/common/constants'
import { getMimeType } from '@any-listen/common/mime'
import { buildVirtualPublicPath } from '@any-listen/common/tools'
import type { EventType } from '@any-listen/nodejs/Event'
import Router from '@koa/router'
import Koa from 'koa'

import { mergeSetting } from '@/app/app/data'
import { Event } from '@/app/app/event'
import { createAppState } from '@/app/app/state'
import { createHotKeyModule } from '@/app/modules/hotKey'
import { createOnlineMusic } from '@/app/modules/music/online'
import { createPlayerModule } from '@/app/modules/player'
import { createThemeModule } from '@/app/modules/theme'
import { createExposeData } from '@/app/renderer/winMain/rendererEvent/data'
import { createExposeDislike, createServerDislike } from '@/app/renderer/winMain/rendererEvent/dislike'
import { createExposeHotkey, createServerHotkey } from '@/app/renderer/winMain/rendererEvent/hotkey'
import { connectRenderer } from '@/app/renderer/winMain/rendererEvent'
import { createExposeList, createServerList } from '@/app/renderer/winMain/rendererEvent/list'
import { createExposeMusic } from '@/app/renderer/winMain/rendererEvent/music'
import { createExposePlayer, createServerPlayer } from '@/app/renderer/winMain/rendererEvent/player'
import { createExposeResource } from '@/app/renderer/winMain/rendererEvent/resource'
import { createExposeSoundEffect } from '@/app/renderer/winMain/rendererEvent/soundEffect'
import { createExposeTheme, createServerTheme } from '@/app/renderer/winMain/rendererEvent/theme'
import { createSocketEvent } from '@/modules/ipc/event'
import { createSocketService } from '@/modules/ipc/socketService'
import type { ServerSocket } from '@/modules/ipc/socketService'
import { PUBLIC_RESOURCE_PATH } from '@/shared/constants'

import { version } from '../../package.json'
import { registerAccountBackup, validatePersonalData } from './backup'
import { materializeSourceResult } from './extensionClient'
import { protectRpc, sanitizeExtension } from './managed'
import { verifyIdentity } from './security'
import type { SharedExtensions, SharedResult } from './sharedExtensions'
import { createAccountStores } from './stores'
import { createDraftExtensions } from './draftExtensions'

export type SiteSettings = { proxyAllResources: boolean; onlineResourceEnabled: boolean; ghMirrorHosts: string }

export const createAccountContext = async (options: {
  id: string
  directory: string
  temporaryDirectory: string
  secret: string
  database: DBSeriveTypes
  sources: SharedExtensions
  site: SiteSettings
  role?: 'admin' | 'user'
  workerEntry?: string
  allowedOrigins?: string[]
}) => {
  const { id, database, sources } = options
  const state = createAppState()
  state.dataPath = path.join(options.directory, 'app')
  state.cacheDataPath = path.join(options.temporaryDirectory, 'cache')
  state.tempDataPath = path.join(options.temporaryDirectory, 'temp')
  state.version.version = version
  state.machineId = id
  await Promise.all([state.dataPath, state.cacheDataPath, state.tempDataPath].map(dir => mkdir(dir, { recursive: true })))
  const stores = createAccountStores(state.dataPath, console)
  const event = new Event()
  const appEvent = event as EventType<Event>
  const pending = new Set<Promise<unknown>>()
  const subscriptions: Array<() => void> = []
  const controller = new AbortController()
  let closed = false
  let site = options.site
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    if (closed) throw new Error('Account is closed')
    if (pending.size >= 128) throw new Error('Account request queue is full')
    const task = Promise.resolve().then(action)
    pending.add(task)
    try { return await task } finally { pending.delete(task) }
  }
  const socketEvent = createSocketEvent()
  const identity = (req: http.IncomingMessage) => verifyIdentity(req.headers['x-anylisten-identity'], options.secret, id)
  const sockets = createSocketService(socketEvent, async req => {
    const auth = identity(req)
    if (!auth) throw new Error('Unauthorized')
    return { clientId: auth.sessionId, timestamp: Date.now() }
  }, () => {}, console, 1012)
  const broadcast = (action: (socket: ServerSocket) => void) => sockets.broadcast(socket => {
    if (socket.winType === 'main' && socket.isInited && socket.readyState === socket.OPEN) action(socket)
  })
  const settings = (input?: Partial<AnyListen.AppSetting>, notify = true) => {
    const result = mergeSetting(state.appSetting, { ...input,
      'sync.webdav.enable': false, 'network.proxy.enable': false,
      'network.proxyAllResources': site.proxyAllResources,
      'onlineResource.enable': site.onlineResourceEnabled, 'extension.ghMirrorHosts': site.ghMirrorHosts,
    })
    stores.get(STORE_NAMES.APP_SETTINGS).override({ version: result.setting.version, setting: result.setting })
    state.appSetting = result.setting
    if (notify && result.updatedSettingKeys.length) {
      appEvent.updated_config(result.updatedSettingKeys, result.updatedSetting)
      broadcast(socket => { void socket.remote.settingChanged(result.updatedSettingKeys, result.updatedSetting).catch(() => {}) })
    }
  }
  settings(stores.get(STORE_NAMES.APP_SETTINGS).get<Partial<AnyListen.AppSetting>>('setting') ?? undefined, false)
  const theme = createThemeModule(state, appEvent, stores.get)
  const hotkey = createHotKeyModule(stores.get)
  const dislike = createDislikeList(database)
  const proxy = createProxyService()
  const files = createCache<string>({ max: 256 })
  const draft = options.role === 'admin' ? createDraftExtensions({
    entry: options.workerEntry!, directory: path.join(state.dataPath, 'extension'),
    origins: options.allowedOrigins ?? [], mirrors: () => site.ghMirrorHosts,
    locale: () => state.appSetting['common.langId'] ?? DEFAULT_LANG,
    icon: file => {
      const name = randomUUID() + path.extname(file)
      files.set(name, file)
      return buildVirtualPublicPath(PUBLIC_RESOURCE_PATH, name)
    },
  }) : undefined
  const materialize = (result: SharedResult) => materializeSourceResult(result, proxy.createProxy, (name, file) => { files.set(name, file) })
  let sourceCalls = 0
  const sourceCall = async (name: string, args: unknown[]) => {
    if (closed) throw new Error('Account is closed')
    if (sourceCalls >= 16) throw new Error('Account source queue is full')
    sourceCalls++
    try { return await materialize(await sources.call(name, args, state.appSetting['common.langId'] ?? DEFAULT_LANG, controller.signal)) }
    finally { sourceCalls-- }
  }
  const extension = new Proxy({} as ExtensionSeriveTypes, {
    get(_target, name) {
      if (name === 'then' || typeof name !== 'string') return undefined
      return (...args: unknown[]) => sourceCall(name, args)
    },
  })
  const resourceState = { resources: {} as AnyListen.Extension.ResourceList['resources'] }
  const resources = createResources(extension, resourceState)
  const utilService = new Proxy({} as UtilSeriveTypes, {
    get(_target, name) {
      if (name === 'then' || typeof name !== 'string') return undefined
      return async (...args: unknown[]) => {
        if (!['lyricS2T', 'langS2T', 'langT2S'].includes(name)) throw new Error('Local tools are unavailable')
        const service = await import('@any-listen/app/modules/worker/utilService/common')
        return (service[name as keyof typeof service] as (...args: unknown[]) => unknown)(...structuredClone(args))
      }
    },
  })
  const workers = { dbService: database, extensionService: extension, utilService }
  const music = createOnlineMusic(state, workers, resources)
  const lists = createMusicList(database,
    async () => stores.get(STORE_NAMES.LIST_SCROLL_POSITION).getAll(),
    async info => { stores.get(STORE_NAMES.LIST_SCROLL_POSITION).override(info) }, validatePersonalData)
  const sync = createOnlineListSync(lists, async list => {
    if (list.meta.sourceType === 'songlist') return resources.songlistDetailAll(list.meta.extensionId, list.meta.source, list.meta.syncId)
    if (list.meta.sourceType === 'topSongs') return resources.topSongsDetailAll(list.meta.extensionId, list.meta.source, list.meta.syncId, String(list.meta.date ?? ''))
    throw new Error('Unsupported online list source')
  }, async list => { await database.updateUserLists([list]) }, console.error)
  const player = createPlayerModule(state, appEvent, database, lists.musicListEvent, lists.sendMusicListAction, true)
  const server = http.createServer()
  const close = async () => {
    if (closed) return
    closed = true
    sockets.destroySockets()
    sockets.close()
    server.close()
    controller.abort()
    const errors: unknown[] = []
    const cleanup = async (action: () => unknown) => {
      try { await action() } catch (error) { errors.push(error) }
    }
    await cleanup(proxy.close)
    await cleanup(sync.close)
    await Promise.allSettled(pending)
    await cleanup(() => draft?.close())
    await nextTurn()
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
    await cleanup(player.closePlayer)
    await cleanup(lists.close)
    await cleanup(dislike.close)
    resources.close()
    theme.closeTheme()
    hotkey.closeHotKey()
    event.listeners.clear()
    files.clear()
    stores.close()
    if (errors.length) throw new AggregateError(errors, 'Account cleanup failed')
  }
  try {
    await Promise.all([proxy.initProxyServer(`/u/${id}`, `${API_PREFIX}${PROXY_SERVER_PATH}`, state.cacheDataPath),
      theme.initTheme(), hotkey.initHotKey(), player.initPlayer(), database.musicUrlClear()])
    resourceState.resources = (await extension.getResourceList()).resources
    const playerActions = createServerPlayer(sockets.broadcast, player.getPlayerEvent(), subscriptions)
    const themeActions = createServerTheme(sockets.broadcast)
    const hotkeyActions = createServerHotkey(sockets.broadcast)
    createServerList(sockets.broadcast, lists.onMusicListAction, subscriptions)
    createServerDislike(sockets.broadcast, dislike.onDislikeAction, subscriptions)
    subscriptions.push(theme.themeEvent.on('theme_change', themeActions.themeChanged),
      theme.themeEvent.on('theme_list_change', themeActions.themeListChanged),
      hotkey.hotKeyEvent.on('hot_key_config_update', hotkeyActions.hotKeyConfigUpdated),
      player.getPlayerEvent().on('collectStatus', status => { void playerActions.playerAction({ action: 'collectStatus', data: status }) }))
    const expose = {
      ...createExposePlayer(player, true), ...createExposeTheme(theme), ...createExposeHotkey(hotkey),
      ...createExposeDislike(dislike), ...createExposeData(stores.get, state, ver => { state.version.ignoreVersion = ver }),
      ...createExposeSoundEffect(stores.get), ...createExposeResource(resources),
      ...createExposeMusic({ ...music, getMusicPic: music.getMusicPicUrl }, workers, state),
      ...createExposeList({ ...lists, getListsCover: ids => lists.getListsCover(ids, music.getMusicPicUrl),
        syncUserList: async id => {
          const list = (await lists.getAllUserLists()).userList.find(list => list.id === id)
          if (list?.type !== 'online') throw new Error('Not an online list')
          await sync.syncList(list)
        }, sortListMusics: async () => { throw new Error('Local list sorting is unavailable') } }, true),
      async inited(socket: ServerSocket) { socket.isInited = true; socketEvent.new_socket_inited(socket) },
      async getAppInfo() { return { machineId: id, proxyServerHost: `/u/${id}` } },
      async getSetting() { return state.appSetting },
      async setSetting(_socket: ServerSocket, input: Partial<AnyListen.AppSetting>) {
        const allowed = Object.fromEntries(Object.entries(input).filter(([key]) =>
          !['extension.', 'network.', 'download.', 'sync.'].some(prefix => key.startsWith(prefix)) && key !== 'common.tryAutoUpdate'))
        settings(allowed)
        if ('common.langId' in allowed) {
          const data = draft ? await draft.call('getLocalExtensionList', []) as AnyListen.Extension.Extension[]
            : (await extension.getLocalExtensionList()).map(item => sanitizeExtension(item) as AnyListen.Extension.Extension)
          broadcast(socket => { void socket.remoteQueueExtension.extensionEvent({ action: 'listSet', data }).catch(() => {}) })
        }
      },
      async setSystemThemeMode(_socket: ServerSocket, dark: boolean) {
        if (state.shouldUseDarkColors === dark) return
        state.shouldUseDarkColors = dark
        appEvent.system_theme_change(dark)
      },
      async getCurrentVersionInfo() { return state.version },
      async checkUpdate() { return false },
      async getSyncState() { return { webdav: { status: 'idle', nextSyncTime: 0 } } },
      async getCacheSize() { return getCacheSize(proxy.state) },
      async clearCache() { await clearCache(proxy.state) },
      async getExtensionErrorMessage() { return null },
      async getNewVersionInfo() { return {} },
      async getResourceList() { return extension.getResourceList() },
      async getExtensionList() { return extension.getLocalExtensionList() },
    }
    for (const name of ['getMusicUrl', 'getMusicPic', 'getMusicLyric'] as const) {
      const action = expose[name]
      expose[name] = async (socket, info) => {
        if (info.musicInfo.isLocal) throw new Error('Local music is unavailable in online-only mode')
        return action(socket, info) as any
      }
    }
    const adminExpose = draft ? Object.fromEntries([
      'getOnlineExtensionList', 'getOnlineExtensionDetail', 'getOnlineCategories', 'getOnlineTags',
      'downloadAndParseExtension', 'installExtension', 'updateExtension', 'enableExtension', 'disableExtension',
      'uninstallExtension', 'getAllExtensionSettings', 'getExtensionConfigValues', 'updateExtensionSettings',
    ].map(name => [name, async (_socket: ServerSocket, ...args: unknown[]) => {
      const result = await draft.call(name, args)
      if (name === 'updateExtensionSettings') {
        broadcast(socket => { void socket.remoteQueueExtension.extensionEvent({ action: 'extenstionSettingUpdated',
          data: { id: args[0] as string, keys: Object.keys(args[1] as object), setting: args[1] as Record<string, unknown> } }).catch(() => {}) })
      }
      if (['installExtension', 'updateExtension', 'enableExtension', 'disableExtension', 'uninstallExtension'].includes(name)) {
        const data = await draft.call('getLocalExtensionList', []) as AnyListen.Extension.Extension[]
        broadcast(socket => { void socket.remoteQueueExtension.extensionEvent({ action: 'listSet', data }).catch(() => {}) })
      }
      return result
    }])) : {}
    if (draft) Object.assign(adminExpose, {
      getAppLogs: (_socket: ServerSocket, type: AnyListen.LogType) => logs[type].getLogs(),
      clearAppLog: (_socket: ServerSocket, type: AnyListen.LogType) => logs[type].clearLog(),
      getExtensionList: () => draft.call('getLocalExtensionList', []),
      restartExtensionHost: () => draft.call('getLocalExtensionList', []),
      getExtensionLastLogs: (_socket: ServerSocket, id?: string) => sourceCall('getExtensionLastLogs', [id]),
      clearExtensionLogs: (_socket: ServerSocket, id?: string) => sourceCall('clearExtensionLogs', [id]),
    })
    if (draft) subscriptions.push(appLogEvent.on('logOutput', (type, log) => {
      broadcast(socket => { void socket.remote.appLog(type, log).catch(() => {}) })
    }))
    subscriptions.push(connectRenderer(socketEvent, protectRpc({ ...expose, ...adminExpose }, { role: options.role ?? 'user', run })))
    const app = new Koa()
    app.on('error', () => {})
    app.use(async (ctx, next) => {
      if (!identity(ctx.req)) { ctx.status = 401; return }
      ctx.set('Cache-Control', 'private, no-store')
      await run(next)
    })
    const router = new Router<unknown, AnyListen.RequestContext>({ prefix: API_PREFIX })
    registerAccountBackup(router, database, lists.sendMusicListAction)
    const headers = (ctx: Koa.Context) => {
      const result = { ...ctx.headers }
      for (const key of Object.keys(result)) if (key.startsWith('x-anylisten-') || ['authorization', 'cookie'].includes(key)) delete result[key]
      return result
    }
    for (const [route, request] of [[PROXY_SERVER_PATH, proxy.proxyRequest], [PROXY_URL_PATH, proxy.proxyRequestByUrl]] as const)
      router.get(`${route}/:name`, async ctx => {
        const signal = new AbortController()
        ctx.res.once('close', () => signal.abort())
        const result = await request(ctx.params.name, headers(ctx), signal.signal)
        if (!result) { ctx.status = 404; return }
        ctx.status = result.statusCode
        for (const [key, value] of Object.entries(result.headers)) if (value) ctx.set(key, value)
        ctx.body = result.body
      })
    router.get('/proxyUrlToken', ctx => { ctx.body = 'OK' })
    app.use(router.routes()).use(router.allowedMethods())
    app.use(async ctx => {
      if (!['GET', 'HEAD'].includes(ctx.method) || !ctx.path.startsWith(PUBLIC_RESOURCE_PATH + '/')) return
      const name = ctx.path.slice(PUBLIC_RESOURCE_PATH.length + 1)
      const file = files.get(name)
      if (!file) return
      ctx.type = getMimeType(path.extname(file))
      ctx.body = createReadStream(file)
    })
    server.on('request', app.callback())
    server.on('upgrade', sockets.onUpgrade)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    appEvent.inited()
    sync.start()
    void sync.syncAllList().catch(console.error)
    return {
      port: (server.address() as { port: number }).port,
      get busy() { return pending.size + sourceCalls + Number(sync.isSyncing()) + proxy.state.activeWriteStreams.size },
      updateSite(value: SiteSettings) { site = value; settings() },
      importScript: draft ? (fileName: string, content: string) => run(() => draft.importScript(fileName, content)) : undefined,
      importRemoteScript: draft ? (url: unknown) => run(() => draft.importRemoteScript(url)) : undefined,
      exportScripts: draft ? () => run(() => draft.exportScripts()) : undefined,
      importPackage: draft ? (content: Buffer) => run(() => draft.importPackage(content)) : undefined,
      draftStatus: () => draft?.status() ?? { workers: 0, queued: 0 },
      async sourceEvent(result: SharedResult) {
        if (closed) return
        const event = await materialize(result) as AnyListen.IPCExtension.EventExtension
        if (event.action === 'logOutput' && options.role !== 'admin') return
        if (event.action === 'resourceUpdated') resourceState.resources = event.data.resources
        if (closed) return
        broadcast(socket => { void socket.remoteQueueExtension.extensionEvent(event).catch(() => {}) })
      },
      close,
    }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
