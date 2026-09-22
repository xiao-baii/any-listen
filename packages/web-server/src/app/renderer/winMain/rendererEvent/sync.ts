import { getSyncWebDAVState, onWebDAVSyncStatusChanged, runSyncWebDAV } from '@/app/modules/sync'
import { broadcast } from '@/modules/ipc/websocket'

import type { ExposeServerFunctions, ExposeClientFunctions } from '.'

// 暴露给前端的方法
export const createExposeSync = () => {
  return {
    async getSyncState() {
      const webdavState = getSyncWebDAVState()
      return {
        webdav: {
          status: webdavState.status,
          error: webdavState.error?.message,
          nextSyncTime: webdavState.nextSyncTime,
        },
      }
    },
    async runSyncWebDAV(event, getListMergeMode, getDislikeMergeMode) {
      return runSyncWebDAV(getListMergeMode, getDislikeMergeMode)
    },
  } satisfies Partial<ExposeClientFunctions>
}

// 暴露给后端的方法
export const createServerSync = () => {
  const actions = {
    async webdavSyncStatus(state) {
      broadcast((socket) => {
        if (socket.winType != 'main' || !socket.isInited) return
        return socket.remoteQueueSync.webdavSyncStatus(state)
      })
    },
  } satisfies Partial<ExposeServerFunctions>

  onWebDAVSyncStatusChanged((state) => {
    void actions.webdavSyncStatus(state)
  })

  return actions
}
