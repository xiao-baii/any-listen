import { MessageChannel, Worker } from 'node:worker_threads'

import type { AccountDatabaseActions } from '@any-listen/app/modules/worker/dbService/service'
import { createMessage2Call } from 'message2call'

type RemoteDatabase = {
  [K in keyof AccountDatabaseActions]: (
    ...args: Parameters<AccountDatabaseActions[K]>
  ) => Promise<Awaited<ReturnType<AccountDatabaseActions[K]>>>
}

export class SharedDatabase {
  private worker: Worker | undefined
  private closed = false
  private channels = new Map<() => Promise<void>, () => void>()
  private closing: Promise<void> | undefined

  constructor(private entry: string) {}

  status() {
    return { workers: this.worker ? 1 : 0, channels: this.channels.size }
  }

  async open(dataPath: string, nativeBindingPath: string, machineId: string) {
    if (this.closed) throw new Error('Database worker is closed')
    if (!this.worker) {
      const worker = new Worker(this.entry)
      this.worker = worker
      const failed = () => {
        if (this.worker !== worker) return
        this.worker = undefined
        for (const abort of this.channels.values()) abort()
      }
      worker.on('error', failed)
      worker.on('exit', failed)
    }
    const { port1, port2 } = new MessageChannel()
    const rpc = createMessage2Call<RemoteDatabase>({
      exposeObj: {},
      timeout: 30_000,
      sendMessage: (data) => port1.postMessage(data),
    })
    let settled = false
    let resolveReady: () => void
    let rejectReady: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    let ended = false
    let closing = false
    let resolveClosed: () => void
    let rejectClosed: (error: Error) => void
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve
      rejectClosed = reject
    })
    // The worker can fail before the owner starts awaiting closure.
    void closed.catch(() => {})
    const finish = (error?: Error) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      if (!settled) rejectReady(new Error('Database channel closed before initialization'))
      rpc.destroy()
      port1.close()
      this.channels.delete(close)
      if (error) rejectClosed(error)
      else resolveClosed()
    }
    const abort = () => finish(new Error('Database channel disconnected'))
    let timer = setTimeout(abort, 30_000)
    const close = () => {
      if (!ended && !closing) {
        closing = true
        clearTimeout(timer)
        timer = setTimeout(abort, 30_000)
        port1.postMessage({ type: 'close' })
      }
      return closed
    }
    this.channels.set(close, abort)
    port1.on('close', abort)
    port1.on('message', (data) => {
      if (data?.type === 'closed') {
        finish()
        return
      }
      if (!settled) {
        if (data?.type !== 'ready' && data?.type !== 'error') return
        settled = true
        clearTimeout(timer)
        if (data.type === 'error') rejectReady(new Error(data.message))
        else resolveReady()
      } else rpc.message(data)
    })
    try {
      this.worker.postMessage({ port: port2, dataPath, nativeBindingPath, machineId }, [port2])
      await ready
    } catch (error) {
      port2.close()
      abort()
      throw error
    }
    let pending = 0
    const service = new Proxy(rpc.remote, {
      get(target, name) {
        if (name === 'then' || typeof name !== 'string') return undefined
        return async (...args: unknown[]) => {
          if (ended || closing) throw new Error('Database channel is closed')
          if (pending >= 128) throw new Error('Database queue is full')
          pending++
          try {
            const action = target[name as keyof RemoteDatabase] as (...args: unknown[]) => Promise<unknown>
            return await action(...args)
          } finally {
            pending--
          }
        }
      },
    })
    return { service, close, closed }
  }

  close() {
    return (this.closing ??= this.shutdown())
  }

  private async shutdown() {
    this.closed = true
    const results = await Promise.allSettled([...this.channels.keys()].map((close) => close()))
    const worker = this.worker
    this.worker = undefined
    if (worker)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          void worker.terminate().then(() => reject(new Error('Database shutdown timed out')))
        }, 30_000)
        worker.once('exit', (code) => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(`Database worker exited (${code})`))
        })
        worker.postMessage({ type: 'shutdown' })
      })
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
