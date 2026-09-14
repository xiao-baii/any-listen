import { createDBServiceWorker, createExtensionServiceWorker, createUtilServiceWorker } from './utils'

let dbService: ReturnType<typeof createDBServiceWorker>
let utilService: ReturnType<typeof createUtilServiceWorker>
let extensionService: ReturnType<typeof createExtensionServiceWorker> | null
let sharedExtensionService: ReturnType<typeof createExtensionServiceWorker>['service'] | undefined

export const workers = {
  get dbService() {
    return dbService
  },
  get utilService() {
    return utilService
  },
  get extensionService() {
    if (sharedExtensionService) return sharedExtensionService
    if (extensionService == null) throw new Error('Extension host not available')
    return extensionService.service
  },
  get extensionServiceWorker() {
    if (extensionService == null) throw new Error('Extension host not available')
    return extensionService.worker
  },
}

export const startDBServiceWorker = async (onWorkerInited: () => void) => {
  dbService = createDBServiceWorker(onWorkerInited)
}

export const setExtensionService = (service: NonNullable<typeof sharedExtensionService>) => {
  sharedExtensionService = service
}

export const setDBService = (service: typeof dbService) => {
  dbService = service
}

export const setUtilService = (service: typeof utilService) => {
  utilService = service
}

export const startUtilServiceWorker = async (
  onWorkerInited: () => void,
  exposedFuncs: Omit<AnyListen.WorkerUtilSeriveExposedTypes, 'inited'>
) => {
  utilService = createUtilServiceWorker(onWorkerInited, exposedFuncs)
}

export const startExtensionServiceWorker = async (
  onWorkerInited: () => void,
  exposedFuncs: AnyListen.IPCExtension.MainIPCActions
) => {
  let oldService = extensionService
  extensionService = createExtensionServiceWorker(onWorkerInited, exposedFuncs)
  extensionService.worker.on('exit', () => {
    extensionService?.worker.removeAllListeners()
    extensionService = null
  })
  if (oldService) {
    oldService.worker.removeAllListeners()
    await oldService.worker.terminate().catch((err) => {
      console.error(err)
    })
  }
}
