import {
  musicListEvent as defaultMusicListEvent,
  sendMusicListAction as defaultSendMusicListAction,
} from '@any-listen/app/modules/musicList'
import {
  createPlayer,
  getPlayInfo as getPlayInfoRaw,
  getPlayMusicInfo,
  initPlayer as initPlayerModule,
  playerEvent,
  setPlayInfo,
  setPlayMusic,
  setPlayMusicInfo,
  setPlayTime,
} from '@any-listen/app/modules/player'
import { LIST_IDS } from '@any-listen/common/constants'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { appEvent as defaultAppEvent, appState as defaultAppState } from '@/app/app'
import { workers as defaultWorkers } from '@/app/worker'

export const createPlayerModule = (
  appState: typeof defaultAppState,
  appEvent: typeof defaultAppEvent,
  database: typeof defaultWorkers.dbService,
  musicListEvent: typeof defaultMusicListEvent,
  sendMusicListAction: typeof defaultSendMusicListAction,
  managed: boolean
) => {
  const workers = { dbService: database }
  const subscriptions: Array<() => void> = []
  const tasks = new Set<Promise<unknown>>()
  const taskErrors: unknown[] = []
  let closing = false
  const track = <A extends unknown[]>(action: (...args: A) => unknown) => (...args: A) => {
    if (closing) return Promise.resolve()
    const task = Promise.resolve().then(() => action(...args))
    tasks.add(task)
    void task.then(() => tasks.delete(task), error => {
      tasks.delete(task)
      taskErrors.push(error)
    })
    return task.then(() => {}, () => {})
  }
  let accountPlayer: ReturnType<typeof createPlayer> | undefined
  const currentPlayer = () =>
    accountPlayer ?? {
      getPlayInfo: getPlayInfoRaw,
      getPlayMusicInfo,
      playerEvent,
      setPlayInfo,
      setPlayMusic,
      setPlayMusicInfo,
      setPlayTime,
    }

  const registerProgressSave = () => {
    const { playerEvent, setPlayTime } = currentPlayer()
    const handler = async (progress: AnyListen.IPCPlayer.Progress) => {
      await setPlayTime(progress.nowPlayTime)
    }
    const tracked = track(handler)
    playerEvent.on('progress', tracked)

    return () => {
      playerEvent.off('progress', tracked)
    }
  }

  const updateLatestPlayList = async (info: AnyListen.Player.PlayMusicInfo) => {
    if (info.listId == LIST_IDS.LAST_PLAYED) return
    const list = await workers.dbService.getListMusics(LIST_IDS.LAST_PLAYED)
    const mId = info.musicInfo.id
    const addType = appState.appSetting['list.addMusicLocationType']
    if (list.some((m) => m.id == mId)) {
      if (list[addType == 'top' ? 0 : list.length - 1].id != mId) {
        await sendMusicListAction({
          action: 'list_music_update_position',
          data: {
            listId: LIST_IDS.LAST_PLAYED,
            position: addType == 'top' ? 0 : list.length - 1,
            ids: [mId],
          },
        })
      }
    } else {
      // @ts-expect-error
      const newInfo: AnyListen.Music.MusicInfo = {
        ...info.musicInfo,
        meta: {
          ...info.musicInfo.meta,
          createTime: Date.now(),
        },
      }
      await sendMusicListAction({
        action: 'list_music_add',
        data: {
          id: LIST_IDS.LAST_PLAYED,
          addMusicLocationType: addType,
          musicInfos: [newInfo],
        },
      })
      if (list.length + 1 > 1000) {
        await sendMusicListAction({
          action: 'list_music_remove',
          data: {
            listId: LIST_IDS.LAST_PLAYED,
            ids: [list[addType == 'top' ? list.length - 1 : 0].id],
          },
        })
      }
    }
  }

  const checkCollect = async (minfo: AnyListen.Player.PlayMusicInfo) => {
    return minfo.listId == LIST_IDS.LOVE ? true : workers.dbService.checkListExistMusic(LIST_IDS.LOVE, minfo.musicInfo.id)
  }
  const initPlayer = async () => {
    if (managed) accountPlayer = createPlayer(workers.dbService, appState.dataPath)
    else initPlayerModule(workers.dbService, appState.dataPath)
    const { playerEvent, getPlayMusicInfo, setPlayMusic, setPlayMusicInfo, setPlayInfo } = currentPlayer()
    let prevCollectStatus = false
    playerEvent.on('musicChanged', track(async (index: number, historyIndex: number, lastTrackId: string | null) => {
      await setPlayMusic(index, historyIndex, lastTrackId)
      const prevMusic = getPlayMusicInfo()
      const targetMusic = await getPlayerMusic()
      setPlayMusicInfo(targetMusic)
      if (targetMusic) {
        await updateLatestPlayList(targetMusic)
        await checkCollect(targetMusic).then((isCollect) => {
          prevCollectStatus = isCollect
          playerEvent.collectStatus(isCollect)
        })
        // TODO play count
        // let mInfo = getMusicInfo(targetMusic.musicInfo)
        // workers.dbService.playCountAdd({ name: mInfo.name, singer: mInfo.singer })
        // await musicListEvent.list_update_play_count(targetMusic.listId, targetMusic.musicInfo.name, targetMusic.musicInfo.singer)
        // workers.dbService.updateMetadataPlayCount()
      }
      if (prevMusic && prevMusic.itemId != targetMusic?.itemId && prevMusic.playLater) {
        await playerEvent.playListAction({ action: 'remove', data: [prevMusic.itemId] })
      }
    }))
    playerEvent.on('playInfoUpdated', track((info: AnyListen.IPCPlayer.PlayInfo['info'] & { duration: number }) =>
      setPlayInfo(info.duration, info.index, info.lastTrackId, info.isLinkedList)))
    let unregistered: (() => void) | null = null
    if (appState.appSetting['player.isSavePlayTime']) unregistered = registerProgressSave()
    subscriptions.push(
      appEvent.on('updated_config', track(async (config: Array<keyof AnyListen.AppSetting>, setting: Partial<AnyListen.AppSetting>) => {
        if (config.includes('player.isSavePlayTime')) {
          if (setting['player.isSavePlayTime']!) {
            if (unregistered) return
            unregistered = registerProgressSave()
          } else {
            if (!unregistered) return
            unregistered()
            unregistered = null
          }
        }
        if (config.includes('player.togglePlayMethod')) {
          await workers.dbService.getPlayList().then(async (playList) => {
            if (playList.some((m) => m.played)) {
              await playerEvent.playListAction({ action: 'unplayedAll' })
            }
          })
          await workers.dbService.queryMetadataPlayHistoryList().then(async (historyList) => {
            if (!historyList.length) return
            await playerEvent.playHistoryListAction({ action: 'setList', data: [] })
          })
        }
      }))
    )

    playerEvent.on('playListAction', track(async (action: Parameters<typeof playerEvent.playListAction>[0]) => {
      if (action.action == 'set') {
        if (!action.data.isSync) {
          const historyList = await workers.dbService.queryMetadataPlayHistoryList()
          if (!historyList.length) return
          await playerEvent.playHistoryListAction({ action: 'setList', data: [] })
        }
      } else if (action.action == 'remove') {
        const ids = action.data
        const historyList = await workers.dbService.queryMetadataPlayHistoryList()
        if (!historyList.length) return
        const idxs: number[] = []
        historyList.forEach((item, idx) => {
          if (ids.includes(item.id)) idxs.push(idx)
        })
        if (idxs.length) await playerEvent.playHistoryListAction({ action: 'removeIdx', data: idxs })
      } else if (action.action == 'update') {
        const data = action.data
        const playerMusic = getPlayMusicInfo()
        if (playerMusic) {
          const targetMusic = data.find((m) => m.listId == playerMusic.listId && m.musicInfo.id == playerMusic.musicInfo.id)
          if (targetMusic) {
            setPlayMusicInfo({
              ...playerMusic,
              musicInfo: targetMusic.musicInfo,
            })
          }
        }

        const updatedInfo = await workers.dbService.musicsUpdateLastPlayedList(
          data.map((m) => ({ id: m.listId, musicInfo: m.musicInfo }))
        )
        if (!updatedInfo.length) return
        await sendMusicListAction({ action: 'list_music_update', data: updatedInfo })
      }
    }))

    subscriptions.push(
      musicListEvent.on('list_music_changed', track(async (ids: string[]) => {
        if (!ids.includes(LIST_IDS.LOVE)) return
        await getPlayerMusic().then(async (music) => {
          if (!music) return
          const isCollect = await checkCollect(music)
          if (isCollect == prevCollectStatus) return
          prevCollectStatus = isCollect
          playerEvent.collectStatus(isCollect)
        })
      }))
    )

    subscriptions.push(
      appEvent.on('inited', track(async () => {
        await getPlayerMusic().then(async (music) => {
          if (music) {
            await checkCollect(music).then((isCollect) => {
              playerEvent.collectStatus(isCollect)
            })
          }
        })
      }))
    )
  }

  // export const updatePlayCount = (name?: string, singer?: string, count?: number) => {
  //   if (name) workers.dbService.playCountAdd({ name, singer: singer! })
  //   workers.dbService.updateMetadataPlayCount(count)
  // }

  const getPlayInfo = async (): Promise<AnyListen.IPCPlayer.PlayInfo> => {
    const playInfo = await currentPlayer().getPlayInfo()
    const [[list, isCollect], { listId, source }, historyList] = await Promise.all([
      workers.dbService.getPlayList().then(async (list) => {
        const minfo = list[playInfo.index]
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!minfo) return [list, false] as const
        return [list, await checkCollect(minfo)] as const
      }),
      workers.dbService.queryMetadataPlayListInfo(),
      workers.dbService.queryMetadataPlayHistoryList(),
    ])
    return {
      info: playInfo,
      list,
      listId,
      source,
      historyList,
      isCollect,
    }
  }

  const getPlayerMusic = async (): Promise<AnyListen.Player.PlayMusicInfo | null> => {
    const playInfo = await currentPlayer().getPlayInfo()
    const list = await workers.dbService.getPlayList()
    return list[playInfo.index] ?? null
  }

  const getPlayerEvent = () => currentPlayer().playerEvent
  const closePlayer = async () => {
    await nextTurn()
    while (tasks.size) {
      await Promise.allSettled(tasks)
      await nextTurn()
    }
    closing = true
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
    if (accountPlayer) await accountPlayer.close()
    if (taskErrors.length) throw taskErrors.shift()
  }
  return { initPlayer, getPlayInfo, getPlayerMusic, getPlayerEvent, closePlayer }
}

let player: ReturnType<typeof createPlayerModule> | undefined
export const initPlayer = async () => {
  player = createPlayerModule(
    defaultAppState,
    defaultAppEvent,
    defaultWorkers.dbService,
    defaultMusicListEvent,
    defaultSendMusicListAction,
    Boolean(process.env.ANYLISTEN_USER_ID)
  )
  await player.initPlayer()
}
const requirePlayer = () => {
  if (!player) throw new Error('Player has not been initialized')
  return player
}
export const getPlayInfo = () => requirePlayer().getPlayInfo()
export const getPlayerMusic = () => requirePlayer().getPlayerMusic()
export const getPlayerEvent = () => requirePlayer().getPlayerEvent()
export const closePlayer = async () => {
  await player?.closePlayer()
}
