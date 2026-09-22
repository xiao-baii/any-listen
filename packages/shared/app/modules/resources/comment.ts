/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { services, type ResourceServices } from './shared'

export const createComments = (services: ResourceServices) => {
  const musicComment = async ({
    extensionId,
    source,
    musicInfo,
    type,
    id,
    page,
    limit,
  }: {
    extensionId: string
    source: string
    musicInfo: AnyListen.Music.MusicInfoOnline
    type: AnyListen.IPCExtension.MusicCommentParams['type']
    id?: string
    page: number
    limit?: number
  }): Promise<AnyListen.IPCResource.MusicCommentResult> => {
    return services.extensionSerive
      .resourceAction('musicComment', {
        extensionId,
        source,
        musicInfo,
        type,
        limit,
        page,
        id,
      })
      .then(({ list, total, limit, page }) => ({ list, total, limit, page }))
  }
  return { musicComment }
}

export const { musicComment } = createComments(services)
