import { createMessage2Call } from 'message2call'

import { socketEvent } from '@/modules/ipc/event'
import type { ServerSocketWinMain } from '@/modules/ipc/websocket'
import { appLog } from '@/shared/log4js'

import { createExposeApp, createServerApp } from './app'
import { createExposeData } from './data'
import { createExposeDislike, createServerDislike } from './dislike'
import { createExposeExtension, createServerExtension } from './extension'
import { createExposeHotkey, createServerHotkey } from './hotkey'
import { createExposeList, createServerList } from './list'
import { createExposeMusic, createExposeLocalMusic } from './music'
import { createExposePlayer, createServerPlayer } from './player'
import { createExposeResource } from './resource'
import { createExposeSoundEffect } from './soundEffect'
import { createExposeSync, createServerSync } from './sync'
import { createExposeTheme, createServerTheme } from './theme'

export type ExposeServerFunctions = Omit<
  AnyListen.IPC.ClientIPCActions,
  'winShow' | 'hotKeyDown' | 'showMessageBox' | 'showInputBox' | 'showOpenBox' | 'showSaveBox' | 'fullscreen'
>

export type ExposeClientFunctions = Omit<
  AnyListen.IPC.ServerIPCActions<ServerSocketWinMain>,
  | 'closeWindow'
  | 'exitApp'
  | 'minWindow'
  | 'fullscreenWindow'
  | 'getHotkeyStatus'
  | 'createDesktopLyricProcess'
  | 'showOpenDialog'
  | 'showSaveDialog'
  | 'openDirInExplorer'
  | 'clipboardReadText'
  | 'clipboardWriteText'
  | 'openDevTools'
  | 'openUrl'
  | 'messageBoxConfirm'
  | 'getSystemFonts'
  | 'showDesktopLyric'
  | 'hideDesktopLyric'
  | 'setBackupPath'
>

let isInitialized = false
export const init = () => {
  if (isInitialized) return
  isInitialized = true
  Object.assign(rendererIPC, createServerPlayer())

  const exposeObj: ExposeClientFunctions = {
    ...createExposeApp(),
    ...createExposePlayer(),
    ...createExposeData(),
    ...createExposeHotkey(),
    ...createExposeList(),
    ...createExposeMusic(),
    ...createExposeLocalMusic(),
    ...createExposeResource(),
    ...createExposeDislike(),
    ...createExposeTheme(),
    ...createExposeExtension(),
    ...createExposeSoundEffect(),
    ...createExposeSync(),
  }

  connectRenderer(socketEvent, exposeObj)
}

export const connectRenderer = (events: typeof socketEvent, exposeObj: Record<string, (...args: any[]) => any>, logger: Pick<Console, 'error'> = appLog) => {
  return events.on('new_socket', (socket) => {
    if (socket.winType != 'main') return
    const msg2call = createMessage2Call<AnyListen.IPC.ClientCommonActions>({
      exposeObj,
      timeout: 0,
      isSendErrorStack: import.meta.env.DEV,
      sendMessage(data) {
        socket.sendMessage(data)
      },
      onCallBeforeParams(rawArgs) {
        return [socket, ...rawArgs]
      },
      onError(error, path, groupName) {
        const name = groupName ?? ''
        // const userName = socket.userInfo?.name ?? ''
        // const deviceName = socket.keyInfo?.deviceName ?? ''
        if (path[0] !== 'appLog') logger.error(`[Client RPC ${name} ${path.join('.')}] Failed`, error)
        // if (groupName == null) return
        // // TODO
        // socket.close(IPC_CLOSE_CODE.failed)
      },
    })
    socket.remote = msg2call.remote
    socket.remoteQueueTheme = msg2call.createRemoteGroup('theme', { queue: true, timeout: 0 })
    socket.remoteQueuePlayer = msg2call.createRemoteGroup('player', { queue: true, timeout: 0 })
    socket.remoteQueueList = msg2call.createRemoteGroup('list', { queue: true, timeout: 0 })
    socket.remoteQueueDislike = msg2call.createRemoteGroup('dislike', { queue: true, timeout: 0 })
    socket.remoteQueueSync = msg2call.createRemoteGroup('sync', { queue: true, timeout: 0 })
    socket.remoteQueueExtension = msg2call.createRemoteGroup('extension_q', { queue: true, timeout: 0 })
    socket.remoteExtension = msg2call.createRemoteGroup('extension', { timeout: 60_000 })
    socket.onMessage = (message) => {
      msg2call.message(message)
    }
    socket.onClose(() => {
      msg2call.destroy()
    })
  })
}

export const rendererIPC = {
  ...createServerApp(),
  // Player listeners must bind after the account player has been initialized.
  ...createServerHotkey(),
  ...createServerList(),
  ...createServerDislike(),
  ...createServerTheme(),
  ...createServerExtension(),
  ...createServerSync(),
} as ExposeServerFunctions
