import type Store from '@any-listen/nodejs/Store'

import { createAccountStores } from '@/accounts/stores'
import { appState } from '@/app/app'

let stores: ReturnType<typeof createAccountStores> | undefined

export const getStore = (name: string): Store => {
  stores ??= createAccountStores(appState.dataPath)
  return stores.get(name)
}

export type { Store }
