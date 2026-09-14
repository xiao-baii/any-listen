import { workers, setUtilService } from '@any-listen/app/modules/worker'

import { exposedFuncs } from '@/app/modules/extension/exposeFuncs'
import { connectSharedExtensions, usesSharedExtensions } from '@/accounts/extensionClient'

import { startDBServiceWorker } from './dbService'
import { startExtensionServiceWorker as _startExtensionServiceWorker } from './extenstion'
import { startUtilServiceWorker } from './utilService'

export const startCommonWorkers = async (dataPath: string) => {
  if (process.env.ANYLISTEN_USER_ID) {
    const lazyService = new Proxy({} as typeof workers.utilService, {
      get(_target, name) {
        if (name === 'then' || typeof name !== 'string') return undefined
        return async (...args: unknown[]) => {
          if (!['lyricS2T', 'langS2T', 'langT2S'].includes(name))
            throw new Error('Local file tools are unavailable in online-only mode')
          const service = await import('@any-listen/app/modules/worker/utilService/common')
          const action = service[name as keyof typeof service] as (...args: unknown[]) => unknown
          // Match the old Worker boundary: conversion must not mutate cached database results.
          return action(...structuredClone(args))
        }
      },
    })
    setUtilService(lazyService)
    return startDBServiceWorker(dataPath)
  }
  return Promise.all([startDBServiceWorker(dataPath), startUtilServiceWorker()])
}

export const startExtensionServiceWorker = async () => {
  if (usesSharedExtensions) { connectSharedExtensions(); return }
  await _startExtensionServiceWorker(exposedFuncs)
}

export { startDBServiceWorker, startUtilServiceWorker, workers }
