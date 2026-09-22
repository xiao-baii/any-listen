import { appState } from '@/app/app'
import { getLyricInfo, getMusicPic, getMusicUrl } from '@/app/modules/music'
import { workers } from '@/app/worker'

import type { ExposeClientFunctions } from '.'

// 暴露给前端的方法
export const createExposeMusic = (service = { getLyricInfo, getMusicPic, getMusicUrl }, database = workers.dbService) => {
  const { getLyricInfo, getMusicPic, getMusicUrl } = service
  return {
    async getMusicUrl(event, info) {
      return getMusicUrl(info)
    },
    async getMusicUrlCount(event) {
      return database.musicUrlCount()
    },
    async clearMusicUrl(event) {
      return database.musicUrlClear()
    },

    async getMusicPic(event, info) {
      return getMusicPic(info)
    },

    async getMusicLyric(event, info) {
      return getLyricInfo(info)
    },
    async setMusicLyric(event, id, info) {
      return database.editedLyricSave(id, info)
    },
    async removeMusicLyric(event, id) {
      return database.editedLyricRemove([id])
    },
    async getMusicLyricCount(event) {
      return database.rawLyricCount()
    },
    async clearMusicLyric(event) {
      return database.rawLyricClear()
    },
  } satisfies Partial<ExposeClientFunctions>
}
export const createExposeLocalMusic = () => ({
  async createLocalMusicInfos(event, paths) {
    return workers.utilService.createLocalMusicInfos(paths, appState.machineId, true)
  },
} satisfies Partial<ExposeClientFunctions>)
