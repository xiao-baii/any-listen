import type { DBSeriveTypes } from '@any-listen/app/modules/worker/utils'
import { createMessage2Call } from 'message2call'

export const connectAccountDatabase = async (machineId: string): Promise<DBSeriveTypes> => {
  const rpc = createMessage2Call<{ call: (name: string, args: unknown[]) => Promise<unknown> }>({
    exposeObj: {},
    timeout: 30_000,
    sendMessage(data) {
      if (!process.connected) throw new Error('Account database disconnected')
      process.send!({ type: 'databaseCall', data })
    },
  })
  const receiveResult = (message: { type?: string; data?: unknown }) => {
    if (message.type === 'databaseResult') rpc.message(message.data)
  }
  const destroy = () => {
    process.off('message', receiveResult)
    process.off('disconnect', destroy)
    rpc.destroy()
  }
  process.on('message', receiveResult)
  process.once('disconnect', destroy)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Account database initialization timed out')), 30_000)
    const receive = (message: { type?: string; error?: string }) => {
      if (message.type === 'databaseReady') finish(message.error ? new Error(message.error) : undefined)
    }
    const finish = (error?: Error) => {
      clearTimeout(timer)
      process.off('message', receive)
      if (error) {
        destroy()
        reject(error)
      } else resolve()
    }
    process.on('message', receive)
    process.send!({ type: 'databaseOpen', machineId })
  })
  let pending = 0
  return new Proxy({} as DBSeriveTypes, {
    get(_target, name) {
      if (name === 'then' || typeof name !== 'string') return undefined
      return async (...args: unknown[]) => {
        if (pending >= 128) throw new Error('Database queue is full')
        pending++
        try {
          return await rpc.remote.call(name, args)
        } finally {
          pending--
        }
      }
    },
  })
}
