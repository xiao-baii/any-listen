import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { extensionEvent } from '@any-listen/app/modules/extension'
import { createProxy } from '@any-listen/app/modules/proxyServer'
import { setExtensionService } from '@any-listen/app/modules/worker'
import type { ExtensionSeriveTypes } from '@any-listen/app/modules/worker/utils'
import { DEFAULT_LANG } from '@any-listen/common/constants'
import { buildVirtualPublicPath } from '@any-listen/common/tools'
import { createMessage2Call } from 'message2call'

import { PUBLIC_RESOURCE_PATH } from '@/shared/constants'

import type { SharedResult } from './sharedExtensions'

export const usesSharedExtensions = process.env.ANYLISTEN_SHARED_EXTENSIONS === 'true'

export const materializeSourceResult = async ({ value, assets }: SharedResult,
  proxy = createProxy,
  registerFile = (name: string, file: string) => { global.anylisten.publicStaticPaths.set(name, file) }) => {
  const urls = new Map<string, string>()
  for (const [token, asset] of Object.entries(assets)) {
    if ('url' in asset) urls.set(token, await proxy(asset.url, asset.options, asset.cache))
    else {
      const name = randomUUID() + path.extname(asset.file)
      registerFile(name, asset.file)
      // Static files have the same account authentication as proxy streams.
      urls.set(token, buildVirtualPublicPath(PUBLIC_RESOURCE_PATH, name))
    }
  }
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return urls.get(item) ?? item
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, visit(value)]))
    return item
  }
  return visit(value)
}

export const connectSharedExtensions = () => {
  let locale: AnyListen.Locale = DEFAULT_LANG
  let pending = 0
  const rpc = createMessage2Call<{ call: (name: string, args: unknown[], locale: AnyListen.Locale) => Promise<SharedResult> }>({
    exposeObj: {},
    timeout: 45_000,
    sendMessage: (data) => {
      if (!process.connected) throw new Error('Shared source disconnected')
      process.send!({ type: 'extensionCall', data })
    },
  })
  const receive = (message: { type?: string; data?: unknown }) => {
    if (message.type === 'extensionResult') rpc.message(message.data)
    else if (message.type === 'extensionEvent')
      void materializeSourceResult(message.data as SharedResult)
        .then((event) => extensionEvent.extensionEvent(event as AnyListen.IPCExtension.EventExtension))
        .catch(() => {})
  }
  process.on('message', receive)
  process.once('disconnect', () => {
    process.off('message', receive)
    rpc.destroy()
  })
  const call = async (name: string, args: unknown[]) => materializeSourceResult(await rpc.remote.call(name, args, locale))
  setExtensionService(
    new Proxy({} as ExtensionSeriveTypes, {
      get(_target, name) {
        if (name === 'then' || typeof name !== 'string') return undefined
        return async (...args: unknown[]) => {
          if (name === 'updateLocale') {
            locale = args[0] as AnyListen.Locale
            const list = await call('getLocalExtensionList', [])
            extensionEvent.extensionEvent({ action: 'listSet', data: list as AnyListen.Extension.Extension[] })
            return
          }
          // Account-specific settings and events never enter the public host.
          if (
            [
              'playerEvent',
              'playListAction',
              'playHistoryListAction',
              'musicListAction',
              'updateProxy',
              'updateEnableDebug',
              'updateGHMirrorHosts',
              'updateOnlineExtensionListHost',
            ].includes(name)
          )
            return
          if (pending >= 16) throw new Error('Account source queue is full')
          pending++
          try {
            return await call(name, args)
          } finally {
            pending--
          }
        }
      },
    })
  )
}
