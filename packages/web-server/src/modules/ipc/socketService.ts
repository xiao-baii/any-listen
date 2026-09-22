import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { IPC_CLOSE_CODE } from '@any-listen/common/constants'
import type WS from 'ws'
import { WebSocketServer } from 'ws'

import type { socketEvent as defaultSocketEvent } from './event'
import { decryptMsg, encryptMsg } from './tools'

export interface KeyInfo {
  clientId: string
  timestamp: number
  // deviceName: string
  // lastConnectDate?: number
  // isMobile: boolean
}
export interface Status {
  status: boolean
  message: string
  address: string[]
  // code: string
  devices: KeyInfo[]
}
interface ServerSocketBase extends WS.WebSocket {
  aliveTime: number
  isReady: boolean
  isInited: boolean
  keyInfo: KeyInfo

  sendMessage: (message: unknown) => void
  onMessage?: (message: string) => void
  onClose: (handler: (err: Error) => void | Promise<void>) => () => void
  broadcast: (handler: (client: ServerSocket) => void | Promise<void>) => void

  // remote: AnyListen.IPC.ServerCommonActions
  // remoteQueueList: AnyListen.IPC.ServerListActions
  // remoteQueueDislike: AnyListen.IPC.ServerDislikeActions
}
export interface ServerSocketWinMain extends ServerSocketBase {
  winType: 'main' | 'desktopLyric'
  remote: AnyListen.IPC.ClientICPCommonActions
  remoteQueueTheme: AnyListen.IPCTheme.ClientIPCActions
  remoteQueuePlayer: AnyListen.IPCPlayer.ClientIPCActions
  remoteQueueList: AnyListen.IPCList.ClientIPCActions
  remoteQueueDislike: AnyListen.IPCDislikeList.ClientIPCActions
  remoteQueueSync: AnyListen.IPCSync.ClientIPCActions
  remoteQueueExtension: AnyListen.IPCExtension.ClientIPCActions
  remoteExtension: AnyListen.IPCExtension.ClientIPCActions
}
export type ServerSocket = ServerSocketWinMain

export const createSocketService = (
  socketEvent: typeof defaultSocketEvent,
  authConnect: (request: IncomingMessage) => Promise<KeyInfo>,
  removeClientInfo: (id: string) => void,
  appLog: Pick<Console, 'info' | 'error'>,
  closeCode: number = IPC_CLOSE_CODE.normal
) => {
  const host = 'http://localhost'
  const wss: WS.Server<ServerSocket> = new WebSocketServer({ noServer: true })
  let closed = false

  const winTypes: AnyListen.IPC.WinType[] = ['main', 'desktopLyric'] as const
  const handleConnection = (socket: ServerSocket, request: IncomingMessage) => {
    const queryData = new URL(request.url!, host).searchParams
    const winType = queryData.get('t') as AnyListen.IPC.WinType | null
    if (!winType || !winTypes.includes(winType)) {
      socket.close(IPC_CLOSE_CODE.failed)
      return
    }
    socket.winType = winType

    socket.isInited = false
    socketEvent.new_socket(socket)
    socket.isReady = true
  }
  function noop() {}

  wss.on('connection', (socket, request) => {
    socket.isReady = false
    socket.aliveTime = performance.now()
    socket.on('pong', () => {
      socket.aliveTime = performance.now()
    })

    let closeEvents: Array<(err: Error) => void | Promise<void>> = []
    let disconnected = false

    socket.addEventListener('message', ({ data }) => {
      if (typeof data != 'string') return
      socket.aliveTime = performance.now()
      void decryptMsg(socket.keyInfo, data)
        .then(async (data) => {
          let syncData: unknown
          try {
            syncData = JSON.parse(data)
          } catch (err) {
            appLog.error('parse message error:', err)
            socket.close(IPC_CLOSE_CODE.failed)
            return
          }
          if (!socket.onMessage) await nextTurn()
          if (closed || disconnected) return
          socket.onMessage?.(syncData as string)
        })
        .catch((err: Error) => {
          appLog.error('decrypt message error:', err)
          socket.close(IPC_CLOSE_CODE.failed)
        })
    })
    socket.addEventListener('close', (event) => {
      if (event.code == IPC_CLOSE_CODE.logout) {
        socketEvent.remove_session(socket.keyInfo.clientId)
      }
      const err = new Error('closed')
      for (const handler of closeEvents)
        void Promise.resolve()
          .then(() => handler(err))
          .catch((error) => appLog.error(error))
      closeEvents = []
      disconnected = true
    })
    socket.sendMessage = function (message) {
      // In-flight RPC handlers can finish after their client has disconnected.
      if (socket.readyState !== socket.OPEN) return
      void encryptMsg(socket.keyInfo, JSON.stringify(message))
        .then((data) => {
          if (socket.readyState !== socket.OPEN) return
          socket.send(data)
        })
        .catch((err: Error) => {
          appLog.error('encrypt message error:', err)
          socket.close(IPC_CLOSE_CODE.failed)
        })
    }
    socket.onClose = function (handler: (typeof closeEvents)[number]) {
      if (disconnected) {
        void Promise.resolve()
          .then(() => handler(new Error('closed')))
          .catch((error) => appLog.error(error))
        return () => {}
      }
      closeEvents.push(handler)
      return () => {
        const index = closeEvents.indexOf(handler)
        if (index >= 0) closeEvents.splice(index, 1)
      }
    }
    socket.broadcast = broadcast

    handleConnection(socket, request)
  })

  const unsubscribe = socketEvent.on('remove_session', (id) => {
    removeClientInfo(id)
    for (const socket of wss.clients) {
      if (socket.keyInfo.clientId === id && socket.readyState === socket.OPEN) socket.close(IPC_CLOSE_CODE.logout)
    }
  })

  const interval = setInterval(() => {
    const now = performance.now()
    wss.clients.forEach((socket) => {
      const diff = now - socket.aliveTime
      if (diff > 45_000) {
        appLog.info('[WebSocket] Heartbeat timed out; disconnecting client')
        socket.terminate()
        return
      }

      if (diff > 15_000) {
        socket.ping(noop)
        socket.send('ping', noop)
      }
    })
  }, 30_000)

  wss.on('close', () => {
    clearInterval(interval)
    unsubscribe()
  })
  interval.unref()

  const authConnection = (req: IncomingMessage, callback: (err: Error | null, keyInfo: KeyInfo | null) => void) => {
    authConnect(req)
      .then((keyInfo) => {
        callback(null, keyInfo)
      })
      .catch((err: Error) => {
        callback(err, null)
      })
  }
  function onSocketError(err: Error) {
    appLog.error('[WebSocket] Connection error', err)
  }

  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.addListener('error', onSocketError)
    authConnection(request, (err, keyInfo) => {
      if (socket.destroyed) return
      if (closed || err) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      socket.removeListener('error', onSocketError)

      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.keyInfo = keyInfo!
        wss.emit('connection', ws, request)
      })
    })
  }

  const broadcast = (handler: (client: ServerSocket) => void | Promise<void>) => {
    for (const client of wss.clients) {
      void Promise.resolve(handler(client)).catch((error) => {
        if (client.readyState !== client.OPEN && error instanceof Error && error.message === 'destroy') return
        appLog.error('[WebSocket] Broadcast failed', error)
      })
    }
  }

  const getSockets = () => {
    return Array.from(wss.clients.values())
  }

  const destroySockets = () => {
    for (const client of wss.clients) client.close(closeCode)
  }
  return {
    onUpgrade,
    broadcast,
    getSockets,
    destroySockets,
    close() {
      if (closed) return
      closed = true
      clearInterval(interval)
      unsubscribe()
      for (const client of wss.clients) client.terminate()
      wss.close()
    },
  }
}
