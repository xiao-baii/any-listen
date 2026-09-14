import { extensionEvent } from '../extension'
import type { ExtensionSeriveTypes } from '../worker/utils'

let extensionSerive: ExtensionSeriveTypes
let unsubscribe: (() => void) | undefined
export type ResourceServices = { readonly extensionSerive: ExtensionSeriveTypes }

export const closeService = () => {
  unsubscribe?.()
  unsubscribe = undefined
  resourceState.resources = {}
}

export const initService = async (_extensionSerive: ExtensionSeriveTypes) => {
  unsubscribe?.()
  extensionSerive = _extensionSerive
  resourceState.resources = (await extensionSerive.getResourceList()).resources
  unsubscribe = extensionEvent.on('extensionEvent', (event) => {
    if (event.action != 'resourceUpdated') return
    resourceState.resources = event.data.resources
  })
}
export type ResourceState = typeof resourceState

export const services = {
  get extensionSerive() {
    return extensionSerive
  },
}

export const resourceState: {
  resources: Partial<
    Record<
      AnyListen.Extension.ResourceAction,
      Array<{
        id: string
        name: string
        extensionId: string
      }>
    >
  >
} = {
  resources: {},
}
