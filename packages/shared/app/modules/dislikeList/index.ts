import type { DBSeriveTypes } from '../worker/utils'
import { dislikeListEvent, initDislikeListEvent } from './event'

let dbService: DBSeriveTypes

export const initDislikeList = async (_dbService: DBSeriveTypes) => {
  dbService = _dbService
  initDislikeListEvent(_dbService)
}

export const getDislikeListInfo = async () => {
  return dbService.getDislikeListInfo()
}

export const sendDislikeAction = async (action: AnyListen.IPCDislikeList.ActionList, event = dislikeListEvent) => {
  switch (action.action) {
    case 'dislike_data_overwrite':
      await event.dislike_data_overwrite(action.data)
      break
    case 'dislike_music_add':
      await event.dislike_music_add(action.data)
      break
    case 'dislike_music_clear':
      await event.dislike_music_clear()
      break
  }
}

export const onDislikeAction = (
  dislikeAction: (action: AnyListen.IPCDislikeList.ActionList) => void | Promise<void>,
  event = dislikeListEvent
): (() => void) => {
  const dislike_music_add = async (listData: AnyListen.Dislike.DislikeMusicInfo[]) => {
    return dislikeAction({
      action: 'dislike_music_add',
      data: listData,
    })
  }
  const dislike_data_overwrite = async (rules: AnyListen.Dislike.DislikeRules) => {
    return dislikeAction({
      action: 'dislike_data_overwrite',
      data: rules,
    })
  }
  const dislike_music_clear = async () => {
    return dislikeAction({
      action: 'dislike_music_clear',
    })
  }
  event.on('dislike_music_add', dislike_music_add)
  event.on('dislike_data_overwrite', dislike_data_overwrite)
  event.on('dislike_music_clear', dislike_music_clear)
  return () => {
    event.off('dislike_music_add', dislike_music_add)
    event.off('dislike_data_overwrite', dislike_data_overwrite)
    event.off('dislike_music_clear', dislike_music_clear)
  }
}

export { dislikeListEvent }
export { createDislikeList } from './service'
