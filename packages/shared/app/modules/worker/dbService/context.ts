import { AsyncLocalStorage } from 'node:async_hooks'

import type Database from 'better-sqlite3'

const managedContexts = new Set<DatabaseContext>()

export class DatabaseContext {
  db: Database.Database | undefined
  readonly states = new Map<string, unknown>()
  closed = false

  constructor(readonly managed = false) {
    if (managed) managedContexts.add(this)
  }

  run<T>(action: () => T): T {
    if (this.closed) throw new Error('Database context is closed')
    if (this.managed) {
      managedContexts.delete(this)
      managedContexts.add(this)
    }
    return storage.run(this, action)
  }

  close() {
    if (this.closed) return
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.states.clear()
    managedContexts.delete(this)
    this.closed = true
  }
}

export const getManagedDatabaseContexts = () => managedContexts.values()

const storage = new AsyncLocalStorage<DatabaseContext>()
const defaultContext = new DatabaseContext()

export const getDatabaseContext = () => {
  const context = storage.getStore() ?? defaultContext
  if (context.closed) throw new Error('Database context is closed')
  return context
}

// State belongs to the connection; asynchronous context only selects its owner.
export const databaseState = <T>(key: string, create: () => T): T => {
  const context = getDatabaseContext()
  if (!context.states.has(key)) context.states.set(key, create())
  return context.states.get(key) as T
}
