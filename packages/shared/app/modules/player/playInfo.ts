import { workers } from '../worker'
import type { DBSeriveTypes } from '../worker/utils'
import { getPlayTime, savePlayTime } from './playTimeStore'

export const createPlayInfoService = (
  getDatabase: () => DBSeriveTypes,
  timeStore: { getPlayTime: () => Promise<number>; savePlayTime: (time: number) => Promise<void> }
) => {
  let playInfo: AnyListen.Player.SavedPlayInfo
  let loading: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing = Promise.resolve()
  let dirty = false
  let timeDirty = false
  let closed = false
  let closing: Promise<void> | undefined

  const initPlayInfo = async () => {
    if (closed) throw new Error('Player is closed')
    await (loading ??= Promise.all([getDatabase().queryMetadataPlayInfo(), timeStore.getPlayTime()])
      .then(([info, time]) => {
        playInfo = { ...info }
        if (playInfo.index > -1) playInfo.time = time
      })
      .catch((error: unknown) => {
        loading = undefined
        throw error
      }))
    if (closed) throw new Error('Player is closed')
  }

  const flush = async () => {
    clearTimeout(timer)
    timer = undefined
    if (!dirty && !timeDirty) return writing
    const snapshot = { ...playInfo }
    const saveMetadata = dirty
    const saveTime = timeDirty
    dirty = false
    timeDirty = false
    const next = writing
      .catch(() => {})
      .then(async () => {
        // Both writes must settle before the database owner may close its channel.
        const results = await Promise.allSettled([
          saveMetadata ? getDatabase().saveMetadataPlayInfo(snapshot) : Promise.resolve(),
          saveTime ? timeStore.savePlayTime(snapshot.time) : Promise.resolve(),
        ])
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') {
          dirty ||= saveMetadata
          timeDirty ||= saveTime
          throw failure.reason
        }
      })
    writing = next
    return next
  }
  const savePlayInfoThrottle = (metadata = true, time = false) => {
    dirty ||= metadata
    timeDirty ||= time
    timer ??= setTimeout(() => {
      void flush().catch(() => {})
    }, 500)
  }

  const setPlayTime = async (time: number) => {
    await initPlayInfo()
    if (playInfo.time === time) return
    playInfo.time = time
    savePlayInfoThrottle(false, true)
  }

  const setPlayMusic = async (index: number, historyIndex: number, lastTrackId?: string | null) => {
    await initPlayInfo()
    if (lastTrackId === undefined) lastTrackId = playInfo.lastTrackId
    if (playInfo.index === index && playInfo.historyIndex === historyIndex && playInfo.lastTrackId === lastTrackId) return
    playInfo = {
      index,
      time: 0,
      maxTime: 0,
      historyIndex,
      lastTrackId,
      isLinkedList: playInfo.isLinkedList,
    }
    savePlayInfoThrottle(true, true)
  }

  const setPlayInfo = async (duration?: number, index?: number, lastTrackId?: string | null, isLinkedList?: boolean) => {
    await initPlayInfo()
    let updated = false
    if (duration != null) {
      duration = Math.round(duration)
      if (playInfo.maxTime !== duration) {
        playInfo.maxTime = duration
        updated ||= true
      }
    }
    if (index != null && playInfo.index !== index) {
      playInfo.index = index
      updated ||= true
    }
    if (lastTrackId !== undefined && playInfo.lastTrackId !== lastTrackId) {
      playInfo.lastTrackId = lastTrackId
      updated ||= true
    }
    if (isLinkedList !== undefined && playInfo.isLinkedList !== isLinkedList) {
      playInfo.isLinkedList = isLinkedList
      updated ||= true
    }
    if (!updated) return
    // console.log('setPlayInfo', duration, index)
    savePlayInfoThrottle()
  }

  const getPlayInfo = async () => {
    await initPlayInfo()
    return { ...playInfo }
  }
  return {
    getPlayInfo,
    setPlayInfo,
    setPlayMusic,
    setPlayTime,
    flush,
    close() {
      closed = true
      return (closing ??= (async () => {
        await loading
        await flush()
      })().catch((error: unknown) => {
        closing = undefined
        throw error
      }))
    },
  }
}

export const {
  getPlayInfo,
  setPlayInfo,
  setPlayMusic,
  setPlayTime,
  flush: flushPlayInfo,
} = createPlayInfoService(() => workers.dbService, { getPlayTime, savePlayTime })
