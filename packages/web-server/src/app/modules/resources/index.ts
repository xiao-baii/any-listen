import { initResources as initResourcesModule } from '@any-listen/app/modules/resources'

import { workers } from '@/app/worker'

export const initResources = async () => {
  await initResourcesModule(workers.extensionService)
}

export * from '@any-listen/app/modules/resources'
