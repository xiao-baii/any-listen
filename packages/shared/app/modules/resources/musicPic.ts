import { services, type ResourceServices } from './shared'
import { logs } from '../logs'
import { findMusic } from './tools'
import { allowedUrl, buildExtSourceId, getExtSource } from './utils'

export const createMusicPictures = (
  services: ResourceServices,
  findMusic: typeof import('./tools').findMusic,
  getExtSource: typeof import('./utils').getExtSource
) => {
  const musicPicSearch = async ({
    extensionId,
    source,
    name,
    artist,
  }: {
    extensionId: string
    source: string
    name: string
    artist?: string
  }): Promise<string[]> => {
    return services.extensionSerive
      .resourceAction('musicPicSearch', {
        extensionId,
        source,
        name,
        artist,
      })
  }

  const getMusicPicByExtensionSource = async ({
    extensionId,
    source,
    musicInfo,
  }: {
    extensionId: string
    source: string
    musicInfo: AnyListen.Music.MusicInfoOnline
  }): Promise<string> => {
    return services.extensionSerive
      .resourceAction('musicPic', {
        extensionId,
        source,
        musicInfo,
      })
      .then((result) => {
        // console.log(result)
        if (!result) throw new Error('Get music pic failed')
        if (!allowedUrl(result)) throw new Error('Get music pic failed, url not allowed')
        return result
      })
  }

  const handleGetMusicPic = async (
    {
      musicInfo,
    }: {
      musicInfo: AnyListen.Music.MusicInfoOnline
    },
    excludeList: string[] = []
  ): Promise<string> => {
    const source = getExtSource('musicPic', excludeList, musicInfo.meta.source)
    if (!source) throw new Error('No available music picture source')
    return getMusicPicByExtensionSource({
      extensionId: source.extensionId,
      source: source.id,
      musicInfo,
    }).catch(async (e) => {
      logs.App.logcat.warn(`[Music picture ${source.extensionId}/${source.id}] Source failed; trying alternatives`, e)
      excludeList.push(buildExtSourceId(source.extensionId, source.id))
      return handleGetMusicPic({ musicInfo }, excludeList)
    })
  }

  const getMusicPic = async (data: { musicInfo: AnyListen.Music.MusicInfo }): Promise<string> => {
    return findMusic(data.musicInfo, async (musicInfo) => {
      return handleGetMusicPic({ musicInfo })
    })
  }
  return { musicPicSearch, getMusicPicByExtensionSource, getMusicPic }
}
export const { musicPicSearch, getMusicPicByExtensionSource, getMusicPic } = createMusicPictures(
  services,
  findMusic,
  getExtSource
)
