import { createPlayMusicInfoList } from '@any-listen/common/tools'

import { getSingerMusics } from '@/modules/resource/singer'
import { getPlayInfo, sendPlayListAction } from '@/shared/ipc/player'
import { singer } from '@/shared/ipc/resource'

import * as commit from './commit'
import { applySingerPage } from './listRemoteAction'
import { playerState } from './state'

let pending: { queueId: string; promise: Promise<void> } | undefined
let failure: { queueId: string; page: number; error: unknown } | undefined

export const loadSingerQueue = async (complete = false, retry = false): Promise<void> => {
  const queue = playerState.singerQueue
  if (!queue || (queue.ended && (!complete || queue.startPage === 1))) return
  if (pending?.queueId === queue.queueId) {
    await pending.promise
    if (complete && playerState.singerQueue?.queueId === queue.queueId) return loadSingerQueue(true, retry)
    return
  }
  if (!retry && failure?.queueId === queue.queueId && failure.page === queue.nextPage) throw failure.error
  failure = undefined
  const promise = (async () => {
    const result = complete
      ? { list: await getSingerMusics(queue.extensionId, queue.source, queue.singerId), ended: true }
      : await singer({ extensionId: queue.extensionId, source: queue.source, id: queue.singerId,
          page: queue.nextPage, limit: queue.limit }).then(data => ({
          list: data.list, ended: !data.list.length || data.page * data.limit >= data.total,
        }))
    if (playerState.singerQueue?.queueId !== queue.queueId) return
    const listId = new URLSearchParams({ s: `${queue.extensionId}_${queue.source}`, id: queue.singerId }).toString()
    const data = await sendPlayListAction({ action: 'singerPage', data: {
      queueId: queue.queueId, page: queue.nextPage, ended: result.ended, complete,
      musics: createPlayMusicInfoList({ musicInfos: result.list, listId, source: 'singer', playLater: false }),
    } })
    if (data) applySingerPage(data)
    else {
      const before = playerState.singerQueue
      const info = await getPlayInfo()
      if (playerState.singerQueue !== before) return
      playerState.singerQueue = info.singerQueue
      commit.setPlayListId(info.listId, info.source)
      commit.setPlayListMusic(info.list)
    }
  })().catch((error: unknown) => {
    if (playerState.singerQueue?.queueId === queue.queueId) {
      failure = { queueId: queue.queueId, page: queue.nextPage, error }
    }
    throw error
  }).finally(() => {
    if (pending?.promise === promise) pending = undefined
  })
  pending = { queueId: queue.queueId, promise }
  return promise
}
