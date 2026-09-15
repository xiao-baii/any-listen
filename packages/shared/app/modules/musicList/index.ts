import { LIST_IDS } from '@any-listen/common/constants'
import { arrPush, getRandom } from '@any-listen/common/utils'

import { getSettings } from '../../common'
import { getDeviceId } from '../../common/deviceId'
import {
  parseRemoteMusicInfoMetadata,
  sortRemoteUserList,
  syncOnlineUserList,
  syncRemoteUserList,
  syncAllRemoteUserList,
  syncAllOnlineUserList,
} from '../../modules/extension'
import { workers } from '../worker'
import { proxyCallback, type DBSeriveTypes } from '../worker/utils'
import { initMusicListEvent, musicListEvent, Event } from './event'
import { createMusicList } from './service'
export { createMusicList } from './service'
import {
  handleAddMusics,
  initLocalListProvider,
  parseLocalMusicInfoMetadata,
  sortLocalListMusics,
  syncLocalList,
} from './localListProvider'

let musicList: ReturnType<typeof createMusicList>
export const initMusicList = async (
  dbService: DBSeriveTypes,
  getScrollInfo: () => Promise<AnyListen.List.ListPositionInfo>,
  saveScrollInfo: (info: AnyListen.List.ListPositionInfo) => Promise<void>
) => {
  initMusicListEvent(dbService)
  musicList = createMusicList(dbService, getScrollInfo, saveScrollInfo, undefined, musicListEvent as unknown as Event)
  await initLocalListProvider()
}
export const getAllUserLists = () => musicList.getAllUserLists()
export const getListMusics = (id: string) => musicList.getListMusics(id)
export const getListsCover = (...args: Parameters<typeof musicList.getListsCover>) => musicList.getListsCover(...args)
export const clearListCoverCache = (id?: string) => musicList.clearListCoverCache(id)
export const getMusicExistListIds = (id: string) => musicList.getMusicExistListIds(id)
export const checkListExistMusic = (listId: string, musicId: string) => musicList.checkListExistMusic(listId, musicId)
export const getListScrollInfo = () => musicList.getListScrollInfo()
export const saveListScrollPosition = (id: string, position: number) => musicList.saveListScrollPosition(id, position)
export const sendMusicListAction = (action: AnyListen.IPCList.ActionList) => musicList.sendMusicListAction(action)
export const updateMusicPic = (...args: Parameters<typeof musicList.updateMusicPic>) => musicList.updateMusicPic(...args)
export const updateMusicBaseInfo = (...args: Parameters<typeof musicList.updateMusicBaseInfo>) =>
  musicList.updateMusicBaseInfo(...args)
export const onMusicListAction = (callback: (action: AnyListen.IPCList.ActionList) => Promise<void>) =>
  musicListEvent.on('listAction', callback)

const updateMusicPosition = async (listId: string, ids: string[]) => {
  const musicInfos = await workers.dbService.getListMusics(listId)
  const musicIds = new Set(musicInfos.map((m) => m.id))
  ids = ids.filter((id) => musicIds.has(id))
  await sendMusicListAction({
    action: 'list_music_update_position',
    data: { ids, listId, position: getSettings()['list.addMusicLocationType'] === 'top' ? 0 : musicInfos.length - 1 },
  })
}

const addFolderMusicTasks = new Map<string, () => void>()
export const addFolderMusics = async (listId: string, filePaths: string[], onEnd: (errorMessage?: string | null) => void) => {
  let parsePromise = Promise.resolve(0)
  let files: string[] = []
  const onFilesProxy = proxyCallback(async (paths: string[]) => {
    arrPush(files, paths)
    parsePromise = handleAddMusics(listId, paths, true)
    await parsePromise
  })
  const onEndProxy = proxyCallback((canceled: boolean) => {
    addFolderMusicTasks.delete(listId)
    void parsePromise.finally(() => {
      void updateMusicPosition(listId, files)
      if (canceled) onEnd(null)
      else onEnd()
      onFilesProxy.releaseProxy()
      onEndProxy.releaseProxy()
    })
  })
  const id = await workers.utilService.scanFolderMusics(filePaths, onFilesProxy, onEndProxy)
  addFolderMusicTasks.set(listId, () => {
    void workers.utilService.stopFolderMusicsScan(id)
    onFilesProxy.releaseProxy()
    onEndProxy.releaseProxy()
  })
  return listId
}
export const cancelAddFolderMusics = async (taskId: string) => {
  const cancel = addFolderMusicTasks.get(taskId)
  if (!cancel) return
  cancel()
}
export const getScanTaksIds = async () => {
  return Array.from(addFolderMusicTasks.keys())
}

export const syncUserList = async (id: string) => {
  const userLists = (await workers.dbService.getAllUserLists()).userList
  const targetList = userLists.find((l) => l.id === id)
  if (!targetList) throw new Error('list not found')
  switch (targetList.type) {
    case 'local':
      if (targetList.meta.deviceId !== getDeviceId()) {
        throw new Error('can not sync local list of other device')
      }
      return syncLocalList(targetList)
    case 'remote':
      return syncRemoteUserList(targetList)
    case 'online':
      return syncOnlineUserList(targetList)
    default:
      console.log('not sync list', targetList)
      throw new Error('not supported list type')
  }
}

let syncTaskTimer: ReturnType<typeof setTimeout> | undefined
const stopSyncUserListTask = () => {
  clearTimeout(syncTaskTimer)
  syncTaskTimer = undefined
}
export const runSyncUserListTask = () => {
  stopSyncUserListTask()
  const now = new Date()
  const next = new Date(now)
  next.setHours(getRandom(11, 12), getRandom(0, 59), getRandom(0, 59), getRandom(0, 999))
  if (next.getTime() - now.getTime() <= 1800_000) next.setDate(next.getDate() + 1)
  const nextDelay = next.getTime() - now.getTime()

  syncTaskTimer = setTimeout(() => {
    syncAllRemoteUserList()
    syncAllOnlineUserList()

    runSyncUserListTask()
  }, nextDelay)
}

export const parseMusicMetadata = async (listId: string, musicInfo: AnyListen.Music.MusicInfo) => {
  const userLists = (await workers.dbService.getAllUserLists()).userList
  const targetList = userLists.find((l) => l.id === listId)

  if (musicInfo.isLocal) {
    if (targetList?.type === 'local' && targetList.meta.deviceId !== getDeviceId()) return null
    return parseLocalMusicInfoMetadata(musicInfo)
  }
  return parseRemoteMusicInfoMetadata(musicInfo)
}

export const sortListMusics = async (
  id: string,
  list: AnyListen.Music.MusicInfo[],
  type: AnyListen.List.SortFileType
): Promise<string[]> => {
  const userLists = (await workers.dbService.getAllUserLists()).userList
  const targetList = userLists.find((l) => l.id === id)
  if (!targetList) throw new Error('list not found')
  switch (targetList.type) {
    case 'local':
      if (targetList.meta.deviceId !== getDeviceId()) {
        throw new Error('can not sync local list of other device')
      }
      return sortLocalListMusics(targetList, list as AnyListen.Music.MusicInfoLocal[], type)
    case 'remote':
      return sortRemoteUserList(targetList, list as AnyListen.Music.MusicInfoOnline[], type)
    default:
      console.log('not sync list', targetList)
      throw new Error('not supported list type')
  }
}

export { musicListEvent }
