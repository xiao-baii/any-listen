import { getDislikeListInfo, onDislikeAction, sendDislikeAction } from '@any-listen/app/modules/dislikeList'

import { broadcast } from '@/modules/ipc/websocket'

import type { ExposeServerFunctions, ExposeClientFunctions } from '.'

// 暴露给前端的方法
export const createExposeDislike = (service = { getDislikeListInfo, sendDislikeAction }) => {
  const { getDislikeListInfo, sendDislikeAction } = service
  return {
    async getDislikeInfo() {
      return getDislikeListInfo()
    },
    async dislikeAction(event, action) {
      return sendDislikeAction(action)
    },
  } satisfies Partial<ExposeClientFunctions>
}

// 暴露给后端的方法
export const createServerDislike = (send = broadcast, subscribe = onDislikeAction, subscriptions?: Array<() => void>) => {
  const broadcast = send
  const actions = {
    async dislikeAction(action) {
      broadcast((socket) => {
        if (socket.winType != 'main' || !socket.isInited) return
        void socket.remoteQueueDislike.dislikeAction(action)
      })
    },
  } satisfies Partial<ExposeServerFunctions>

  // eslint-disable-next-line @typescript-eslint/unbound-method
  const unsubscribe = subscribe(actions.dislikeAction)
  subscriptions?.push(unsubscribe)

  return actions
}
