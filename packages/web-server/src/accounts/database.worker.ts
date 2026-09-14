import { setImmediate as yieldToAccounts } from 'node:timers/promises'
import { MessagePort, parentPort } from 'node:worker_threads'

import { createAccountDatabase } from '@any-listen/app/modules/worker/dbService/service'
import { createMessage2Call } from 'message2call'

const channels = new Set<() => Promise<void>>()
let shuttingDown = false
let totalQueued = 0
parentPort!.on('message', (message: { port: MessagePort; dataPath: string; nativeBindingPath: string; machineId: string }) => {
  if (!(message.port instanceof MessagePort)) return
  const port = message.port
  if (shuttingDown) {
    port.close()
    return
  }
  let database: Awaited<ReturnType<typeof createAccountDatabase>> | undefined
  let closed = false
  let pending = Promise.resolve()
  let queued = 0
  let rpc: ReturnType<typeof createMessage2Call> | undefined
  let initializing: Promise<void>
  let closing: Promise<void> | undefined
  const close = () => {
    if (closing) return closing
    closed = true
    closing = (async () => {
      await initializing
      await pending
      database?.close()
      rpc?.destroy()
      port.postMessage({ type: 'closed' })
      port.close()
      channels.delete(close)
    })()
    return closing
  }
  channels.add(close)
  port.on('close', () => {
    void close()
  })
  initializing = createAccountDatabase(message.dataPath, message.nativeBindingPath, message.machineId)
    .then((value) => {
      database = value
      if (closed) {
        database.close()
        return
      }
      // Each authenticated channel owns one database. Client messages cannot select another account.
      const exposeObj = Object.fromEntries(
        Object.entries(database.service).map(([name, action]) => [
          name,
          (...args: unknown[]) => {
            if (closed) throw new Error('Database channel is closed')
            if (queued >= 128 || totalQueued >= 1024) throw new Error('Database queue is full')
            queued++
            totalQueued++
            const task = pending.then(async () => {
              await yieldToAccounts()
              return (action as (...args: unknown[]) => unknown)(...args)
            })
            pending = task
              .then(
                () => {},
                () => {}
              )
              .finally(() => {
                queued--
                totalQueued--
              })
            return task
          },
        ])
      )
      rpc = createMessage2Call({
        exposeObj,
        timeout: 0,
        isSendErrorStack: false,
        sendMessage: (data) => port.postMessage(data),
      })
      port.on('message', (data) => {
        if (data?.type === 'close') {
          void close()
          return
        }
        rpc!.message(data)
      })
      port.postMessage({ type: 'ready' })
    })
    .catch((error: Error) => {
      port.postMessage({ type: 'error', message: error.message })
      port.close()
    })
})

parentPort!.on('message', (message) => {
  if (message?.type !== 'shutdown') return
  shuttingDown = true
  void Promise.all([...channels].map((close) => close())).then(() => parentPort!.close())
})
