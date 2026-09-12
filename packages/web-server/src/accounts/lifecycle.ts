import { setTimeout as delay } from 'node:timers/promises'

import { isSyncing as onlineSyncing } from '@any-listen/app/modules/extension/onlineListProvider'
import { isSyncing as remoteSyncing } from '@any-listen/app/modules/extension/remoteListProvider'
import { stopSyncUserListTask, getScanTaksIds, cancelAddFolderMusics } from '@any-listen/app/modules/musicList'
import { getPlayInfo } from '@any-listen/app/modules/player/playInfo'
import { savePlayTime } from '@any-listen/app/modules/player/playTimeStore'
import { proxyServerState } from '@any-listen/app/modules/proxyServer'
import { cancelWebDAVSyncTask, getSyncWebDAVState } from '@any-listen/app/modules/sync'
import { workers } from '@any-listen/app/modules/worker'

import { activeCalls } from './managed'

export const busyTasks = () =>
  activeCalls +
  proxyServerState.activeWriteStreams.size +
  Number(onlineSyncing()) +
  Number(remoteSyncing()) +
  Number(!['idle', 'error'].includes(getSyncWebDAVState().status))
export const flushAccount = async () => {
  cancelWebDAVSyncTask()
  stopSyncUserListTask()
  for (const id of await getScanTaksIds()) await cancelAddFolderMusics(id)
  const deadline = Date.now() + 15_000
  while (busyTasks() && Date.now() < deadline) await delay(50)
  if (busyTasks()) throw new Error('Account tasks did not finish before shutdown')
  const info = await getPlayInfo()
  await workers.dbService.saveMetadataPlayInfo(info)
  await savePlayTime(info.time)
  // Let existing 500 ms player/list throttles finish before the final worker barrier.
  await delay(600)
  await workers.dbService.queryMetadataPlayInfo()
}
