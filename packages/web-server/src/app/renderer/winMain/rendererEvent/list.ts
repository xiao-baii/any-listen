import {
  addFolderMusics,
  cancelAddFolderMusics,
  checkListExistMusic,
  getAllUserLists,
  getListMusics,
  getListScrollInfo,
  getMusicExistListIds,
  onMusicListAction,
  parseMusicMetadata,
  saveListScrollPosition,
  sendMusicListAction,
  sortListMusics,
  syncUserList,
} from '@any-listen/app/modules/musicList'

import { validatePersonalData } from '@/accounts/backup'
import { managed } from '@/accounts/managed'
import { getListsCover, syncOnlineList } from '@/app/modules/musicList'
import { broadcast } from '@/modules/ipc/websocket'

import type { ExposeClientFunctions, ExposeServerFunctions } from '.'

// 暴露给前端的方法
export const createExposeList = (service = { getAllUserLists, getListMusics, getListsCover, getMusicExistListIds,
  checkListExistMusic, sendMusicListAction, getListScrollInfo, saveListScrollPosition, syncOnlineList, sortListMusics }, onlineOnly = managed) => {
  const { getAllUserLists, getListMusics, getListsCover, getMusicExistListIds, checkListExistMusic,
    sendMusicListAction, getListScrollInfo, saveListScrollPosition, syncOnlineList, sortListMusics } = service
  const managed = onlineOnly
  return {
    async getAllUserLists(event) {
      return getAllUserLists()
    },
    async getListMusics(event, listId) {
      return getListMusics(listId)
    },
    async getListCover(event, listId) {
      return (await getListsCover([listId]))[listId]
    },
    async getMusicExistListIds(event, musicId) {
      return getMusicExistListIds(musicId)
    },
    async checkListExistMusic(event, listId, musicId) {
      return checkListExistMusic(listId, musicId)
    },
    async listAction(event, action) {
      if (managed) validatePersonalData(action)
      return sendMusicListAction(action)
    },
    async getListScrollPosition(event) {
      return getListScrollInfo()
    },
    async saveListScrollPosition(event, id, position) {
      return saveListScrollPosition(id, position)
    },
    async addFolderMusics(event, listId, filePaths, onEnd) {
      return addFolderMusics(listId, filePaths, onEnd)
    },
    async cancelAddFolderMusics(event, taskId) {
      return cancelAddFolderMusics(taskId)
    },
    async syncUserList(event, id) {
      if (managed) {
        const list = (await getAllUserLists()).userList.find((list) => list.id === id)
        if (list?.type !== 'online') throw new Error('Not an online list')
        return syncOnlineList(list)
      }
      return syncUserList(id)
    },
    async parseMusicMetadata(event, listId, musicInfo) {
      return parseMusicMetadata(listId, musicInfo)
    },
    async sortListMusics(event, id, list, type) {
      return sortListMusics(id, list, type)
    },
  } satisfies Partial<ExposeClientFunctions>
}

// 暴露给后端的方法
export const createServerList = (send = broadcast, subscribe = onMusicListAction, subscriptions?: Array<() => void>) => {
  const broadcast = send
  const actions = {
    async listAction(action) {
      broadcast((socket) => {
        if (socket.winType != 'main' || !socket.isInited) return
        void socket.remoteQueueList.listAction(action)
      })
    },
  } satisfies Partial<ExposeServerFunctions>

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const unsubscribe = subscribe(actions.listAction)
  subscriptions?.push(unsubscribe)

  return actions
}
