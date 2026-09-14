import { IPC_CLOSE_CODE } from '@any-listen/common/constants'

import { managed } from '@/accounts/managed'
import { removeClientInfo } from '@/shared/data'
import { appLog } from '@/shared/log4js'

import { authConnect } from './auth'
import { socketEvent } from './event'
import { createSocketService } from './socketService'

export type { KeyInfo, Status, ServerSocket, ServerSocketWinMain } from './socketService'
export { createSocketService } from './socketService'

export const {
  onUpgrade,
  broadcast,
  getSockets,
  destroySockets,
  close: closeSockets,
} = createSocketService(socketEvent, authConnect, removeClientInfo, appLog, managed ? 1012 : IPC_CLOSE_CODE.normal)
