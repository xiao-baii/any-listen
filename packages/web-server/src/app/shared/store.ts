import type Store from '@any-listen/nodejs/Store'

import { createAccountStores } from '@/accounts/stores'
import { appState } from '@/app/app'
import { log } from '@/app/shared/log'

let stores: ReturnType<typeof createAccountStores> | undefined

export default (name: string): Store => {
  stores ??= createAccountStores(appState.dataPath, log)
  return stores.get(name)
}

export type { Store }
