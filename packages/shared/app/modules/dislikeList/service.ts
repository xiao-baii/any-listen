import type { EventType } from '@any-listen/nodejs/Event'

import type { DBSeriveTypes } from '../worker/utils'
import { Event } from './event'
import { onDislikeAction, sendDislikeAction } from './index'

export const createDislikeList = (database: DBSeriveTypes) => {
  const event = new Event(database)
  const dislikeListEvent = event as EventType<Event>
  const pending = new Set<Promise<unknown>>()
  let closed = false
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    if (closed) throw new Error('Dislike list is closed')
    const task = action()
    pending.add(task)
    try {
      return await task
    } finally {
      pending.delete(task)
    }
  }
  return {
    dislikeListEvent,
    getDislikeListInfo: () => run(() => database.getDislikeListInfo()),
    sendDislikeAction: (action: AnyListen.IPCDislikeList.ActionList) => run(() => sendDislikeAction(action, dislikeListEvent)),
    onDislikeAction: (listener: Parameters<typeof onDislikeAction>[0]) => {
      if (closed) throw new Error('Dislike list is closed')
      return onDislikeAction(listener, dislikeListEvent)
    },
    async close() {
      closed = true
      const results = await Promise.allSettled(pending)
      event.listeners.clear()
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    },
  }
}
