import { getRandom } from '@any-listen/common/utils'

import type { createMusicList } from './service'

type Lists = Pick<
  ReturnType<typeof createMusicList>,
  'getAllUserLists' | 'commitOnlineListSync' | 'musicListEvent'
>
type SyncKind = 'initial' | 'automatic' | 'manual'

export const createOnlineListSync = (
  lists: Lists,
  detailAll: (list: AnyListen.List.OnlineListInfo) => Promise<AnyListen.Music.MusicInfoOnline[]>,
  onError: (error: unknown) => void
) => {
  let closed = false
  let running: Promise<void> | undefined
  let loading: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Map<string, {
    resolve: () => void
    reject: (error: unknown) => void
    task: Promise<void>
    automatic: boolean
    manual: boolean
  }>()
  const subscriptions: Array<() => void> = []

  const sync = async (id: string, automatic: boolean) => {
    const list = (await lists.getAllUserLists()).userList.find((list) => list.id === id)
    if (closed) return 'closed'
    if (list?.type !== 'online') return 'missing'
    if (automatic && list.meta.autoSync !== true) return 'stale'
    const snapshot = structuredClone(list)
    const online = await detailAll(snapshot)
    if (closed) return 'closed'
    return (await lists.commitOnlineListSync(snapshot, online, automatic)).status
  }
  const drain = async () => {
    while (!closed && pending.size) {
      const [id, item] = pending.entries().next().value!
      try {
        const manual = item.manual
        const result = await sync(id, item.automatic && !manual)
        if (result === 'stale' && !manual && item.manual && !closed) {
          pending.delete(id)
          pending.set(id, item)
          continue
        }
        if (item.manual) {
          if (result === 'missing') throw new Error('Not an online list')
          if (result === 'closed') throw new Error('Online list sync is closed')
          if (result === 'stale') throw new Error('Online list changed during sync. Please try again.')
        }
        item.resolve()
      } catch (error) {
        item.reject(error)
      }
      pending.delete(id)
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
  const enqueue = (id: string, kind: SyncKind) => {
    if (closed) return Promise.reject(new Error('Online list sync is closed'))
    const existing = pending.get(id)
    if (existing) {
      if (kind === 'manual') existing.manual = true
      return existing.task
    }
    if (pending.size >= 128) return Promise.reject(new Error('Online list sync queue is full'))
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const task = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    pending.set(id, { task, resolve, reject, automatic: kind === 'automatic', manual: kind === 'manual' })
    startDrain()
    return task
  }
  const syncAllList = () => {
    if (closed) return Promise.resolve()
    return (loading ??= (async () => {
      const userLists = (await lists.getAllUserLists()).userList
      for (const list of userLists) {
        if (closed) break
        if (list.type === 'online' && list.meta.autoSync === true) await enqueue(list.id, 'automatic').catch(onError)
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
      if (list.type === 'online' && list.meta.autoSync === true) void enqueue(list.id, 'automatic').catch(onError)
    }
  }
  subscriptions.push(
    lists.musicListEvent.on('list_create', async (_position, items, isRemote) => {
      if (closed || isRemote) return
      for (const list of items) {
        if (list.type !== 'online') continue
        const { extensionId, source, syncId } = list.meta
        if (extensionId && source && syncId) void enqueue(list.id, 'initial').catch(onError)
      }
    })
  )
  subscriptions.push(
    lists.musicListEvent.on('list_update', async (items, isSync, isRemote) => {
      if (isSync || isRemote || closed || !Array.isArray(items)) return
      schedule(items)
    })
  )

  return {
    syncList: (list: AnyListen.List.OnlineListInfo) => enqueue(list.id, 'manual'),
    syncAllList,
    start,
    stop,
    isSyncing: () => Boolean(running || loading),
    async close() {
      closed = true
      stop()
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
      for (const item of pending.values()) {
        if (item.manual) item.reject(new Error('Online list sync is closed'))
        else item.resolve()
      }
      await Promise.allSettled([running, loading])
      pending.clear()
    },
  }
}
