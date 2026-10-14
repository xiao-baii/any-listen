import { sendMusicListAction } from '@any-listen/app/modules/musicList'
import { getPlayInfo as getPlayInfoRaw } from '@any-listen/app/modules/player'
import { LIST_IDS } from '@any-listen/common/constants'

import { appState } from '@/app'
import { workers } from '@/worker'

export const checkCollect = async (minfo: AnyListen.Player.PlayMusicInfo) => {
  return minfo.listId == LIST_IDS.LOVE ? true : workers.dbService.checkListExistMusic(LIST_IDS.LOVE, minfo.musicInfo.id)
}

// export const updatePlayCount = (name?: string, singer?: string, count?: number) => {
//   if (name) workers.dbService.playCountAdd({ name, singer: singer! })
//   workers.dbService.updateMetadataPlayCount(count)
// }

export const getPlayInfo = async (): Promise<AnyListen.IPCPlayer.PlayInfo> => {
  const playInfo = await getPlayInfoRaw()
  const [{ list, listId, source, singerQueue }, historyList] = await Promise.all([
    workers.dbService.getPlayListState(),
    workers.dbService.queryMetadataPlayHistoryList(),
  ])
  const isCollect = list[playInfo.index] ? await checkCollect(list[playInfo.index]) : false
  return {
    info: playInfo,
    list,
    listId,
    source,
    singerQueue,
    historyList,
    isCollect,
  }
}

export const getPlayerMusic = async (): Promise<AnyListen.Player.PlayMusicInfo | null> => {
  const playInfo = await getPlayInfoRaw()
  const list = await workers.dbService.getPlayList()
  return list[playInfo.index] ?? null
}

export const collectMusic = async () => {
  const music = await getPlayerMusic()
  if (!music) return
  await sendMusicListAction({
    action: 'list_music_add',
    data: {
      id: LIST_IDS.LOVE,
      musicInfos: [music.musicInfo],
      addMusicLocationType: appState.appSetting['list.addMusicLocationType'],
    },
  })
}

export const uncollectMusic = async () => {
  const music = await getPlayerMusic()
  if (!music) return
  await sendMusicListAction({
    action: 'list_music_remove',
    data: {
      listId: LIST_IDS.LOVE,
      ids: [music.musicInfo.id],
    },
  })
}
