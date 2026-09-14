import { setTimeout as delay } from 'node:timers/promises'

import { isSyncing as onlineSyncing } from '@any-listen/app/modules/extension/onlineListProvider'
import { isSyncing as remoteSyncing } from '@any-listen/app/modules/extension/remoteListProvider'
import { closeMusicList, stopSyncUserListTask, getScanTaksIds, cancelAddFolderMusics } from '@any-listen/app/modules/musicList'
import { proxyServerState, closeProxyServer } from '@any-listen/app/modules/proxyServer'
import { workers } from '@any-listen/app/modules/worker'

import { isOnlineListSyncing, closeOnlineListSync } from '@/app/modules/musicList'
import { closePlayer } from '@/app/modules/player'
import { closeResources } from '@/app/modules/resources'
import { closeTheme } from '@/app/modules/theme'
import { closeHotKey } from '@/app/modules/hotKey'
import { closeStores } from '@/app/shared/store'
import { closeSockets } from '@/modules/ipc/websocket'

import { activeCalls } from './managed'

export const busyTasks = () =>
  activeCalls +
  proxyServerState.activeWriteStreams.size +
  Number(onlineSyncing()) +
  Number(isOnlineListSyncing()) +
  Number(remoteSyncing())
export const flushAccount = async () => {
  closeSockets()
  stopSyncUserListTask()
  await closeOnlineListSync()
  for (const id of await getScanTaksIds()) await cancelAddFolderMusics(id)
  const deadline = Date.now() + 15_000
  while (busyTasks() && Date.now() < deadline) await delay(50)
  if (busyTasks()) throw new Error('Account tasks did not finish before shutdown')
  await closePlayer()
  await closeMusicList()
  closeResources()
  closeTheme()
  closeHotKey()
  await closeProxyServer()
  await workers.dbService.queryMetadataPlayInfo()
  closeStores()
}
