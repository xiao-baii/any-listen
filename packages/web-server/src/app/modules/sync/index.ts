import type { SyncWebDAVOptions } from '@any-listen/app/modules/sync'

import { appEvent, appState } from '@/app/app'

let service: typeof import('@any-listen/app/modules/sync') | undefined
const listeners: Array<(state: AnyListen.IPCSync.SyncState['webdav']) => void | Promise<void>> = []
const init = (immediately?: boolean) => {
  if (appState.appSetting['sync.webdav.enable']) {
    service!.runWebDAVSyncTask(immediately)
  } else {
    service!.cancelWebDAVSyncTask()
  }
}
export const initSync = async () => {
  service = await import('@any-listen/app/modules/sync')
  for (const callback of listeners) service.syncWebDAVEvent.on('statusChanged', callback)
  listeners.length = 0
  appEvent.on('updated_config', (keys, settings) => {
    if (keys.includes('sync.webdav.enable')) {
      init()
    }
  })
  appEvent.on('inited', () => {
    init(true)
  })
}

export const runSyncWebDAV = async (
  getListMergeMode: SyncWebDAVOptions['getListMergeMode'],
  getDislikeMergeMode: SyncWebDAVOptions['getDislikeMergeMode']
) => {
  const { runSyncWebDAV: runSyncWebDAVOriginal } = await import('@any-listen/app/modules/sync')
  return runSyncWebDAVOriginal(
    {
      url: appState.appSetting['sync.webdav.url'],
      username: appState.appSetting['sync.webdav.username'],
      password: appState.appSetting['sync.webdav.password'],
      path: appState.appSetting['sync.webdav.path'],
    },
    {
      getListMergeMode,
      getDislikeMergeMode,
    }
  )
}

export const onWebDAVSyncStatusChanged = (callback: (state: AnyListen.IPCSync.SyncState['webdav']) => void | Promise<void>) => {
  if (service) service.syncWebDAVEvent.on('statusChanged', callback)
  else listeners.push(callback)
}

export const getSyncWebDAVState = () => service?.getSyncWebDAVState() ?? { status: 'idle' as const, error: undefined, nextSyncTime: 0 }
