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
import { getListsCover } from '@/app/modules/musicList'
import { broadcast } from '@/modules/ipc/websocket'

import type { ExposeClientFunctions, ExposeServerFunctions } from '.'

// 暴露给前端的方法
export const createExposeList = (service = { getAllUserLists, getListMusics, getListsCover, getMusicExistListIds,
  checkListExistMusic, sendMusicListAction, getListScrollInfo, saveListScrollPosition, syncUserList, sortListMusics }, onlineOnly = false) => {
  const { getAllUserLists, getListMusics, getListsCover, getMusicExistListIds, checkListExistMusic,
    sendMusicListAction, getListScrollInfo, saveListScrollPosition, syncUserList, sortListMusics } = service
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
      if (onlineOnly) validatePersonalData(action)
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
