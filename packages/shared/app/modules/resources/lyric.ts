import { isValidLyric } from '@any-listen/common/tools'
import { logs } from '../logs'

import { services, type ResourceServices } from './shared'
import { findMusic } from './tools'
import { buildExtSourceId, getExtSource } from './utils'

export const createLyrics = (
  services: ResourceServices,
  findMusic: typeof import('./tools').findMusic,
  getExtSource: typeof import('./utils').getExtSource
) => {
  const lyricSearch = async ({
    extensionId,
    source,
    name,
    artist,
    interval,
  }: {
    extensionId: string
    source: string
    name: string
    artist?: string
    interval?: number
  }): Promise<AnyListen.IPCExtension.LyricSearchResult[]> => {
    // console.log(extensionId, source, name, artist, interval)
    if (!name.trim().length) return []
    return services.extensionSerive
      .resourceAction('lyricSearch', {
        extensionId,
        source,
        name,
        artist,
        interval,
      })
  }
  const getLyric = async ({
    extensionId,
    source,
    id,
  }: {
    extensionId: string
    source: string
    id: string
  }): Promise<AnyListen.Music.LyricInfo> => {
    return services.extensionSerive
      .resourceAction('lyricDetail', {
        extensionId,
        source,
        id,
      })
  }

  const getMusicLyricByExtensionSource = async ({
    extensionId,
    source,
    musicInfo,
  }: {
    extensionId: string
    source: string
    musicInfo: AnyListen.Music.MusicInfoOnline
  }): Promise<AnyListen.Music.LyricInfo> => {
    return services.extensionSerive
      .resourceAction('musicLyric', {
        extensionId,
        source,
        musicInfo,
      })
      .then((result) => {
        // console.log(result)
        if (!isValidLyric(result.lyric)) throw new Error('Get music lyric failed')
        return result
      })
  }

  const handleGetMusicLyric = async (
    {
      musicInfo,
    }: {
      musicInfo: AnyListen.Music.MusicInfoOnline
    },
    excludeList: string[] = []
  ): Promise<AnyListen.Music.LyricInfo> => {
    const source = getExtSource('musicLyric', excludeList, musicInfo.meta.source)
    if (!source) throw new Error('No available lyric source')
    return getMusicLyricByExtensionSource({
      extensionId: source.extensionId,
      source: source.id,
      musicInfo,
    }).catch(async (e) => {
      logs.App.logcat.warn(`[Lyrics ${source.extensionId}/${source.id}] Source failed; trying alternatives`, e)
      excludeList.push(buildExtSourceId(source.extensionId, source.id))
      return handleGetMusicLyric({ musicInfo }, excludeList)
    })
  }

  const getMusicLyric = async (data: { musicInfo: AnyListen.Music.MusicInfo }): Promise<AnyListen.Music.LyricInfo> => {
    return findMusic(data.musicInfo, async (musicInfo) => {
      return handleGetMusicLyric({ musicInfo })
    })
  }
  return { lyricSearch, getLyric, getMusicLyricByExtensionSource, getMusicLyric }
}
export const { lyricSearch, getLyric, getMusicLyricByExtensionSource, getMusicLyric } = createLyrics(
  services,
  findMusic,
  getExtSource
)
