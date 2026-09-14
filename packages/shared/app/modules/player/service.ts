import type { EventType } from '@any-listen/nodejs/Event'

import type { DBSeriveTypes } from '../worker/utils'
import { Event } from './event'
import { createPlayInfoService } from './playInfo'
import { createPlayTimeStore } from './playTimeStore'

export const createPlayer = (database: DBSeriveTypes, dataPath: string) => {
  let closed = false
  const pending = new Set<Promise<unknown>>()
  const trackedDatabase = new Proxy(database, {
    get(target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined
      return (...args: unknown[]) => {
        if (closed) return Promise.reject(new Error('Player is closed'))
        const action = target[name as keyof DBSeriveTypes] as (...args: unknown[]) => Promise<unknown>
        const task = Promise.resolve().then(() => action(...args))
        pending.add(task)
        void task.then(
          () => pending.delete(task),
          () => pending.delete(task)
        )
        return task
      }
    },
  })
  const event = new Event(() => {
    if (closed) throw new Error('Player is closed')
    return trackedDatabase
  })
  const info = createPlayInfoService(
    () => database,
    createPlayTimeStore(() => dataPath)
  )
  let music: AnyListen.Player.PlayMusicInfo | null = null
  return {
    ...info,
    playerEvent: event as EventType<Event>,
    getPlayMusicInfo: () => music,
    setPlayMusicInfo(value: AnyListen.Player.PlayMusicInfo | null) {
      if (closed) throw new Error('Player is closed')
      music = value
    },
    async close() {
      closed = true
      event.listeners.clear()
      music = null
      const tasks = await Promise.allSettled([...pending, info.close()])
      const failed = tasks.find((task) => task.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    },
  }
}
