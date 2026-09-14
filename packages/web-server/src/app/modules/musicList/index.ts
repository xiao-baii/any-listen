import {
  initMusicList as _initMusicList,
  getListsCover as _getListsCover,
  musicListEvent,
  clearListCoverCache,
  runSyncUserListTask,
  getAllUserLists,
  getListMusics,
  sendMusicListAction,
} from '@any-listen/app/modules/musicList'
import { createOnlineListSync } from '@any-listen/app/modules/musicList/onlineSync'
import { STORE_NAMES } from '@any-listen/common/constants'

import { validatePersonalData } from '@/accounts/backup'
import { managed } from '@/accounts/managed'
import { appEvent } from '@/app/app'
import { songlistDetailAll, topSongsDetailAll } from '@/app/modules/resources'
import getStore from '@/app/shared/store'
import { workers } from '@/app/worker'

import { getMusicPic } from '../music'

let onlineSync: ReturnType<typeof createOnlineListSync> | undefined
let unsubscribeInited: (() => void) | undefined
export const isOnlineListSyncing = () => onlineSync?.isSyncing() ?? false
export const closeOnlineListSync = async () => {
  unsubscribeInited?.()
  unsubscribeInited = undefined
  await onlineSync?.close()
}
export const syncOnlineList = async (list: AnyListen.List.OnlineListInfo) => {
  if (!onlineSync) throw new Error('Online list sync has not been initialized')
  await onlineSync.syncList(list)
}

export const getListsCover = async (ids: string[]) => {
  return _getListsCover(ids, getMusicPic)
}

export const initMusicList = async () => {
  await _initMusicList(
    workers.dbService,
    async () => {
      return getStore(STORE_NAMES.LIST_SCROLL_POSITION).getAll()
    },
    async (info) => {
      getStore(STORE_NAMES.LIST_SCROLL_POSITION).override(info)
    },
    managed ? validatePersonalData : undefined,
    { onlineOnly: managed }
  )
  if (managed) {
    onlineSync = createOnlineListSync(
      { getAllUserLists, getListMusics, sendMusicListAction, musicListEvent },
      async (list) => {
        if (list.meta.sourceType === 'songlist')
          return songlistDetailAll(list.meta.extensionId, list.meta.source, list.meta.syncId)
        if (list.meta.sourceType === 'topSongs')
          return topSongsDetailAll(list.meta.extensionId, list.meta.source, list.meta.syncId, String(list.meta.date ?? ''))
        throw new Error('Unsupported online list source')
      },
      async (list) => {
        await workers.dbService.updateUserLists([list])
      },
      console.error
    )
  }
  musicListEvent.on('list_data_overwrite', async () => {
    clearListCoverCache()
  })
  musicListEvent.on('listAction', async (action) => {
    switch (action.action) {
      case 'list_data_overwrite':
        clearListCoverCache()
        break
      case 'list_music_overwrite':
        clearListCoverCache(action.data.listId)
        break
      case 'list_music_add':
        clearListCoverCache(action.data.id)
        break
      case 'list_music_remove':
        clearListCoverCache(action.data.listId)
        break
      case 'list_music_move':
        clearListCoverCache(action.data.fromId)
        clearListCoverCache(action.data.toId)
        break
      case 'list_music_update_position':
        clearListCoverCache(action.data.listId)
        break
      case 'list_music_clear':
        for (const id of action.data) {
          clearListCoverCache(id)
        }
        break

      default:
        break
    }
  })
  unsubscribeInited = appEvent.on('inited', () => {
    if (onlineSync) {
      onlineSync.start()
      void onlineSync.syncAllList().catch(console.error)
    } else runSyncUserListTask()
  })
}
