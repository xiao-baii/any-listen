import { isDeepStrictEqual } from 'node:util'

import { getRandom } from '@any-listen/common/utils'

import type { createMusicList } from './service'

type Lists = Pick<
  ReturnType<typeof createMusicList>,
  'getAllUserLists' | 'getListMusics' | 'sendMusicListAction' | 'musicListEvent'
>

export const createOnlineListSync = (
  lists: Lists,
  detailAll: (list: AnyListen.List.OnlineListInfo) => Promise<AnyListen.Music.MusicInfoOnline[]>,
  saveList: (list: AnyListen.List.OnlineListInfo) => Promise<void>,
  onError: (error: unknown) => void
) => {
  let closed = false
  let running: Promise<void> | undefined
  let loading: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Map<string, { resolve: () => void; reject: (error: unknown) => void; task: Promise<void> }>()
  const subscriptions: Array<() => void> = []

  const sync = async (id: string) => {
    // Reload the list after waiting: it may have been edited or removed meanwhile.
    const list = (await lists.getAllUserLists()).userList.find((list) => list.id === id)
    if (!list) return
    if (list.type !== 'online') throw new Error('Not an online list')
    const [local, online] = await Promise.all([lists.getListMusics(id), detailAll(list)])
    if (closed) return
    const current = (await lists.getAllUserLists()).userList.find((item) => item.id === id)
    if (current?.type !== 'online' || !isDeepStrictEqual(current.meta, list.meta)) return
    const previous = new Map(local.map((music) => [music.id, music]))
    if (local.length !== online.length || online.some((music, index) => local[index]?.id !== music.id)) {
      await lists.sendMusicListAction({
        action: 'list_music_overwrite',
        data: { listId: id, musicInfos: online.map((music) => previous.get(music.id) ?? music) },
      })
    }
    if (closed) return
    const updated = { ...current, meta: { ...current.meta, syncTime: Date.now() } }
    await saveList(updated)
    await lists.sendMusicListAction({
      action: 'list_update',
      data: { lists: [updated], sync: true },
    })
  }
  const drain = async () => {
    while (!closed && pending.size) {
      const [id, item] = pending.entries().next().value!
      try {
        await sync(id)
        item.resolve()
      } catch (error) {
        item.reject(error)
      } finally {
        pending.delete(id)
      }
    }
  }
  const startDrain = () => {
    if (closed || running || !pending.size) return
    running = Promise.resolve()
      .then(drain)
      .finally(() => {
        running = undefined
        startDrain()
      })
  }
  const syncList = (list: AnyListen.List.OnlineListInfo) => {
    if (closed) return Promise.reject(new Error('Online list sync is closed'))
    const existing = pending.get(list.id)
    if (existing) return existing.task
    if (pending.size >= 128) return Promise.reject(new Error('Online list sync queue is full'))
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const task = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    pending.set(list.id, { task, resolve, reject })
    startDrain()
    return task
  }
  const syncAllList = () => {
    if (closed) return Promise.resolve()
    return (loading ??= (async () => {
      const userLists = (await lists.getAllUserLists()).userList
      for (const list of userLists) {
        if (closed) break
        if (list.type === 'online') await syncList(list).catch(onError)
      }
    })().finally(() => {
      loading = undefined
    }))
  }
  const stop = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const start = () => {
    stop()
    if (closed) return
    const now = new Date()
    const next = new Date(now)
    next.setHours(getRandom(11, 12), getRandom(0, 59), getRandom(0, 59), getRandom(0, 999))
    if (next.getTime() - now.getTime() <= 1800_000) next.setDate(next.getDate() + 1)
    timer = setTimeout(() => {
      void syncAllList()
        .catch(onError)
        .finally(() => {
          if (!closed) start()
        })
    }, next.getTime() - now.getTime())
    timer.unref?.()
  }
  const schedule = (items: AnyListen.List.MyListInfo[]) => {
    if (closed) return
    for (const list of items) {
      if (list.type === 'online') void syncList(list).catch(onError)
    }
  }
  subscriptions.push(
    lists.musicListEvent.on('list_create', async (_position, items) => {
      schedule(items)
    })
  )
  subscriptions.push(
    lists.musicListEvent.on('list_update', async (items, isSync, isRemote) => {
      if (isSync || isRemote || closed || !Array.isArray(items)) return
      schedule(items)
    })
  )

  return {
    syncList,
    syncAllList,
    start,
    stop,
    isSyncing: () => Boolean(running || loading),
    async close() {
      closed = true
      stop()
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
      for (const item of pending.values()) item.resolve()
      await Promise.allSettled([running, loading])
      pending.clear()
    },
  }
}
