import { createCache } from '@any-listen/common/cache'
import { LIST_IDS } from '@any-listen/common/constants'
import type { EventType } from '@any-listen/nodejs/Event'

import type { DBSeriveTypes } from '../worker/utils'
import { Event } from './event'

export const createMusicList = (
  dbService: DBSeriveTypes,
  getScrollInfo: () => Promise<AnyListen.List.ListPositionInfo>,
  saveScrollInfo: (info: AnyListen.List.ListPositionInfo) => Promise<void>,
  validateAction?: (action: AnyListen.IPCList.ActionList) => void,
  event = new Event(() => dbService),
  onError: (error: unknown) => void = console.error
) => {
  const musicListEvent = event as EventType<Event>
  let closed = false
  const pending = new Set<Promise<unknown>>()
  const track =
    <A extends unknown[], R>(action: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (closed) return Promise.reject(new Error('Music list is closed'))
      const task = Promise.resolve().then(() => action(...args))
      pending.add(task)
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task)
      )
      return task
    }
  const getAllUserLists = async () => {
    return dbService.getAllUserLists()
  }

  const getListMusics = async (listId: string) => {
    return dbService.getListMusics(listId)
  }

  const cacheListCovers = createCache<{ url: string | null | undefined }>({ max: 128 })
  let coverRevision = 0
  const getListsCover = async (
    ids: string[],
    getMusicPic: (params: {
      musicInfo: AnyListen.Music.MusicInfo
      listId: string
      isRefresh?: boolean
    }) => Promise<{ url: string | null | undefined }>
  ): Promise<Record<string, string | undefined | null>> => {
    const revision = coverRevision
    const emptyCoverListIds: string[] = []
    const covers: Record<string, string | undefined | null> = {}
    for (const id of ids) {
      if (cacheListCovers.has(id)) {
        covers[id] = cacheListCovers.get(id)?.url
        continue
      }
      emptyCoverListIds.push(id)
    }
    if (emptyCoverListIds.length) {
      const listMusics = await dbService.getListsFirstMusics(emptyCoverListIds)
      const coverPromises = listMusics.map<Promise<[string, string | null | undefined]>>(async (musics, index) => {
        const listId = emptyCoverListIds[index]
        if (!musics.length) return [listId, null] as const
        return getMusicPic({ musicInfo: musics[0], listId })
          .then((picInfo) => {
            return [listId, picInfo.url] satisfies [string, string | null | undefined]
          })
          .catch(() => {
            return [listId, null] satisfies [string, string | null | undefined]
          })
      })
      const coversResult = await Promise.all(coverPromises)
      for (const [listId, pic] of coversResult) {
        covers[listId] = pic
        if (!closed && revision === coverRevision) cacheListCovers.set(listId, { url: pic })
      }
    }

    return covers
  }
  const clearListCoverCache = (id?: string) => {
    coverRevision++
    if (id) {
      cacheListCovers.delete(id)
    } else {
      cacheListCovers.clear()
    }
  }

  const getMusicExistListIds = async (musicId: string) => {
    return dbService.getMusicExistListIds(musicId)
  }

  const checkListExistMusic = async (listId: string, musicId: string) => {
    return dbService.checkListExistMusic(listId, musicId)
  }

  let scrollInfo: Map<string, number> | undefined
  let loadingScroll: Promise<void> | undefined
  let scrollTimer: ReturnType<typeof setTimeout> | undefined
  let dirtyScroll = false
  let scrollWrites = Promise.resolve()
  const initScrollInfo = () => {
    if (scrollInfo) return Promise.resolve()
    return (loadingScroll ??= getScrollInfo()
      .then((info) => {
        scrollInfo = new Map(Object.entries(info))
      })
      .finally(() => {
        loadingScroll = undefined
      }))
  }
  const flushScroll = () => {
    clearTimeout(scrollTimer)
    scrollTimer = undefined
    if (!dirtyScroll || !scrollInfo) return scrollWrites
    dirtyScroll = false
    const info = Object.fromEntries(scrollInfo)
    scrollWrites = scrollWrites
      .catch(() => {})
      .then(() => saveScrollInfo(info))
      .catch((error) => {
        dirtyScroll = true
        throw error
      })
    return scrollWrites
  }
  const scheduleScrollSave = () => {
    dirtyScroll = true
    if (!scrollTimer)
      scrollTimer = setTimeout(() => {
        void flushScroll().catch(onError)
      }, 500)
  }
  const getListScrollInfo = async () => {
    await initScrollInfo()
    return Object.fromEntries(scrollInfo!)
  }
  const saveListScrollPosition = async (id: string, position: number) => {
    await initScrollInfo()
    scrollInfo!.set(id, position)
    scheduleScrollSave()
  }
  const removeListScrollInfo = async (ids: string[]) => {
    await initScrollInfo()
    for (const id of ids) scrollInfo!.delete(id)
    scheduleScrollSave()
  }
  const overrideListScrollInfo = async (ids: string[]) => {
    await initScrollInfo()
    const retained = new Set(ids)
    for (const id of scrollInfo!.keys()) {
      if (!retained.has(id)) scrollInfo!.delete(id)
    }
    scheduleScrollSave()
  }

  const songCountIds = new Set<string>()
  let songCountTimer: ReturnType<typeof setTimeout> | undefined
  let songCountTask: Promise<void> | undefined
  const refreshSongCounts = async () => {
    const ids = Array.from(songCountIds)
    songCountIds.clear()
    const lists = (await dbService.getListInfos(ids)).filter(
      (list): list is AnyListen.List.MyListInfo => list != null && !songCountIds.has(list.id)
    )
    if (!closed && lists.length) {
      await musicListEvent.listAction({ action: 'list_update', data: { lists, sync: true } })
    }
  }
  const scheduleSongCounts = () => {
    if (closed || !songCountIds.size || songCountTimer || songCountTask) return
    songCountTimer = setTimeout(() => {
      songCountTimer = undefined
      songCountTask = refreshSongCounts().catch(onError).finally(() => {
        songCountTask = undefined
        scheduleSongCounts()
      })
    }, 500)
    songCountTimer.unref?.()
  }
  const queueSongCounts = (ids: string[]) => {
    if (closed) return
    for (const id of ids) songCountIds.add(id)
    scheduleSongCounts()
  }
  const sendMusicListAction = async (action: AnyListen.IPCList.ActionList) => {
    validateAction?.(action)
    await musicListEvent.listAction(action)
    clearListCoverCache()
    switch (action.action) {
      case 'list_music_overwrite':
        queueSongCounts([action.data.listId])
        break
      case 'list_music_add':
        queueSongCounts([action.data.id])
        break
      case 'list_music_move':
        queueSongCounts([action.data.toId, action.data.fromId])
        break
      case 'list_music_remove':
        queueSongCounts([action.data.listId])
        break
      case 'list_music_clear':
        queueSongCounts(action.data)
        break
      case 'list_data_overwrite': {
        const ids = [LIST_IDS.DEFAULT, LIST_IDS.LOVE, ...action.data.userList.map((l) => l.id)]
        queueSongCounts(ids)
        await overrideListScrollInfo(ids)
        break
      }
      case 'list_remove':
        await removeListScrollInfo(action.data)
        break
      default:
    }
  }

  const commitOnlineListSync = async (
    snapshot: AnyListen.List.OnlineListInfo,
    songs: AnyListen.Music.MusicInfoOnline[],
    automatic: boolean
  ) => {
    const listId = snapshot.id
    validateAction?.({ action: 'list_music_overwrite', data: { listId, musicInfos: songs } })
    const result = await dbService.commitOnlineListSync(snapshot, songs, automatic)
    if (result.status !== 'applied' || closed) return result

    if (result.musicInfos) {
      clearListCoverCache(listId)
      event.notifyMusicOverwrite(listId, result.musicInfos)
      event.emitEvent('listAction', { action: 'list_music_overwrite', data: { listId, musicInfos: result.musicInfos } })
    }
    await musicListEvent.listAction({ action: 'list_update', data: { lists: [result.list], sync: true } })
    return result
  }

  const updateMusicPic = async (listId: string, musicInfo: AnyListen.Music.MusicInfo) => {
    await musicListEvent.list_music_update_pic(listId, musicInfo)
    clearListCoverCache(listId)
  }

  const updateMusicBaseInfo = async (listId: string, musicInfos: AnyListen.Music.MusicInfo[]) => {
    await musicListEvent.list_music_base_info_update(listId, musicInfos)
    clearListCoverCache(listId)
  }

  const onMusicListAction = (listAction: (action: AnyListen.IPCList.ActionList) => Promise<void>): (() => void) => {
    musicListEvent.on('listAction', listAction)
    return () => {
      musicListEvent.off('listAction', listAction)
    }
  }

  return {
    getAllUserLists: track(getAllUserLists),
    getListMusics: track(getListMusics),
    getListsCover: track(getListsCover),
    getMusicExistListIds: track(getMusicExistListIds),
    checkListExistMusic: track(checkListExistMusic),
    getListScrollInfo: track(getListScrollInfo),
    saveListScrollPosition: track(saveListScrollPosition),
    sendMusicListAction: track(sendMusicListAction),
    commitOnlineListSync: track(commitOnlineListSync),
    updateMusicPic: track(updateMusicPic),
    updateMusicBaseInfo: track(updateMusicBaseInfo),
    clearListCoverCache,
    onMusicListAction,
    musicListEvent,
    async close() {
      closed = true
      event.listeners.clear()
      clearTimeout(scrollTimer)
      clearTimeout(songCountTimer)
      songCountIds.clear()
      const results = await Promise.allSettled([...pending, songCountTask])
      try {
        await flushScroll()
      } finally {
        cacheListCovers.clear()
      }
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      scrollInfo?.clear()
    },
  }
}
