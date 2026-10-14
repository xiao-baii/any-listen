import path from 'node:path'

import Store from '@any-listen/nodejs/Store'

export const createAccountStores = (dataPath: string) => {
  const stores = new Map<string, Store>()
  let closed = false
  return {
    get(name: string): Store {
      if (closed) throw new Error('Account stores are closed')
      if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid store name')
      const cached = stores.get(name)
      if (cached) return cached
      const store = new Store(path.join(dataPath, `${name}.json`))
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
