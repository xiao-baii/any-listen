import type Store from '@any-listen/nodejs/Store'

import { createAccountStores } from '@/accounts/stores'
import { appState } from '@/app/app'
import { log } from '@/app/shared/log'

let stores: ReturnType<typeof createAccountStores> | undefined
export const closeStores = () => {
  stores?.close()
  stores = undefined
}

/**
 * 获取 Store 对象
 * @param name store 名
 * @param isIgnoredError 是否忽略错误
 * @param isShowErrorAlert=true 是否显示错误弹窗
 * @returns Store
 */
export default (name: string, isIgnoredError = true, isShowErrorAlert = true): Store => {
  stores ??= createAccountStores(appState.dataPath, log)
  return stores.get(name, isIgnoredError, isShowErrorAlert)
}

export type { Store }
