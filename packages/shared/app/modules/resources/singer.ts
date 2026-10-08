import { services, type ResourceServices } from './shared'

export const createSingers = (services: ResourceServices) => ({
  singerSearch: (params: AnyListen.IPCExtension.CommonSearchParams) =>
    services.extensionSerive.resourceAction('singerSearch', params),
  singer: (params: AnyListen.IPCExtension.ListDetailParams) => services.extensionSerive.resourceAction('singer', params),
})

export const { singerSearch, singer } = createSingers(services)
