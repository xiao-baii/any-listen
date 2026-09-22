/* eslint-disable @typescript-eslint/no-unnecessary-condition */

import { services, type ResourceServices } from './shared'

export const createSearchMeta = (services: ResourceServices) => {
  const tipSearch = async ({
    extensionId,
    source,
    keyword,
  }: {
    extensionId: string
    source: string
    keyword: string
  }): Promise<string[]> => {
    return services.extensionSerive
      .resourceAction('tipSearch', {
        extensionId,
        source,
        keyword,
      })
  }

  const hotSearch = async ({ extensionId, source }: { extensionId: string; source: string }): Promise<string[]> => {
    return services.extensionSerive
      .resourceAction('hotSearch', {
        extensionId,
        source,
      })
  }
  return { tipSearch, hotSearch }
}

export const { tipSearch, hotSearch } = createSearchMeta(services)
