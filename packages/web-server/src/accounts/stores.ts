import fs from 'node:fs'
import path from 'node:path'

import Store from '@any-listen/nodejs/Store'

export const createAccountStores = (dataPath: string, log: Pick<Console, 'error' | 'warn'>) => {
  const stores = new Map<string, Store>()
  let closed = false
  return {
    get(name: string): Store {
      if (closed) throw new Error('Account stores are closed')
      if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid store name')
      const cached = stores.get(name)
      if (cached) return cached
      const storePath = path.join(dataPath, `${name}.json`)
      let store: Store
      try {
        store = new Store(storePath, false)
      } catch (error) {
        log.error(error)
        const backupPath = `${storePath}.bak`
        fs.renameSync(storePath, backupPath)
        log.warn(`${name} data load error; original file saved to ${backupPath}`)
        store = new Store(storePath, true)
      }
      stores.set(name, store)
      return store
    },
    close() {
      // Store uses synchronous safe writes; there are no deferred writes to drain here.
      closed = true
      stores.clear()
    },
  }
}
