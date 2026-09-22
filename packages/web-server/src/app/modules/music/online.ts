import { buildMusicCacheId, getFileType } from '@any-listen/common/tools'

import { appState as defaultAppState } from '@/app/app/state'
import * as defaultResources from '@/app/modules/resources'
import { workers as defaultWorkers } from '@any-listen/app/modules/worker'

import { createMusicCache } from './shared'

export const createOnlineMusic = (
  appState: typeof defaultAppState,
  workers: { dbService: typeof defaultWorkers.dbService; utilService: Pick<typeof defaultWorkers.utilService, 'lyricS2T'> },
  resources: Pick<
    typeof defaultResources,
    | 'getMusicLyricByExtensionSource'
    | 'getMusicLyric'
    | 'getMusicPicByExtensionSource'
    | 'getMusicPic'
    | 'getMusicUrlByExtensionSource'
    | 'getMusicUrl'
  >
) => {
  const {
    getMusicLyricByExtensionSource,
    getMusicLyric: getMusicLyricResource,
    getMusicPicByExtensionSource,
    getMusicPic: getMusicPicResource,
    getMusicUrlByExtensionSource,
    getMusicUrl: getMusicUrlResource,
  } = resources
  const { buildLyricInfo, getCachedLyricInfo, saveLyricInfo } = createMusicCache(appState, workers)

  const getMusicUrlByExtSource = async ({
    musicInfo,
    quality,
    isRefresh = false,
    extensionId,
    source,
  }: {
    musicInfo: AnyListen.Music.MusicInfoOnline
    extensionId: string
    source: string
    isRefresh?: boolean
    quality?: string
  }): Promise<AnyListen.IPCMusic.MusicUrlInfo> => {
    const targetQuality = quality ?? appState.appSetting['player.playQuality']
    const cachedUrl = await workers.dbService.getMusicUrl(buildMusicCacheId(musicInfo, targetQuality))
    if (cachedUrl && !isRefresh) return { isFromCache: true, quality: targetQuality, url: cachedUrl }
    const info = await getMusicUrlByExtensionSource({
      musicInfo,
      quality: targetQuality,
      type: getFileType(targetQuality),
      extensionId,
      source,
    })
    return {
      quality: info.quality,
      url: info.url,
      isFromCache: false,
    }
  }

  const getMusicUrl = async ({
    musicInfo,
    quality,
    isRefresh = false,
  }: {
    musicInfo: AnyListen.Music.MusicInfo
    isRefresh?: boolean
    quality?: string
  }): Promise<AnyListen.IPCMusic.MusicUrlInfo> => {
    const targetQuality = quality ?? appState.appSetting['player.playQuality']
    const id = buildMusicCacheId(musicInfo, targetQuality)
    const cachedUrl = await workers.dbService.getMusicUrl(id)
    if (cachedUrl && !isRefresh) return { isFromCache: true, quality: targetQuality, url: cachedUrl }
    const info = await getMusicUrlResource({
      musicInfo,
      quality: targetQuality,
      type: getFileType(targetQuality),
    })
    await workers.dbService.musicUrlSave([{ id, url: info.url }])
    return {
      quality: info.quality,
      url: info.url,
      isFromCache: false,
    }
  }

  const getMusicPicByExtSource = async ({
    musicInfo,
    isRefresh = false,
    extensionId,
    source,
  }: {
    musicInfo: AnyListen.Music.MusicInfoOnline
    extensionId: string
    source: string
    isRefresh?: boolean
    quality?: string
  }): Promise<AnyListen.IPCMusic.MusicPicInfo> => {
    if (musicInfo.meta.picUrl && !isRefresh) {
      return {
        isFromCache: true,
        url: musicInfo.meta.picUrl,
      }
    }
    const url = await getMusicPicByExtensionSource({
      musicInfo,
      extensionId,
      source,
    })
    return {
      url,
      isFromCache: false,
    }
  }
  const getMusicPicUrl = async ({
    musicInfo,
    isRefresh = false,
  }: {
    musicInfo: AnyListen.Music.MusicInfo
    isRefresh?: boolean
  }): Promise<AnyListen.IPCMusic.MusicPicInfo> => {
    if (musicInfo.meta.picUrl && !isRefresh) {
      return {
        isFromCache: true,
        url: musicInfo.meta.picUrl,
      }
    }
    const url = await getMusicPicResource({ musicInfo })

    return {
      url,
      isFromCache: false,
    }
  }

  const getLyricInfoByExtSource = async ({
    musicInfo,
    isRefresh = false,
    extensionId,
    source,
  }: {
    musicInfo: AnyListen.Music.MusicInfoOnline
    extensionId: string
    source: string
    isRefresh?: boolean
    quality?: string
  }): Promise<AnyListen.IPCMusic.MusicLyricInfo> => {
    if (!isRefresh) {
      const lyricInfo = await getCachedLyricInfo(musicInfo)
      if (lyricInfo) return { info: await buildLyricInfo(lyricInfo), isFromCache: false }
    }
    const info = await getMusicLyricByExtensionSource({
      musicInfo,
      extensionId,
      source,
    })
    await saveLyricInfo(musicInfo, info)
    return {
      info,
      isFromCache: false,
    }
  }
  const getLyricInfo = async ({
    musicInfo,
    isRefresh = false,
  }: {
    musicInfo: AnyListen.Music.MusicInfo
    listId?: string | null
    isRefresh?: boolean
  }): Promise<AnyListen.IPCMusic.MusicLyricInfo> => {
    const [remote, local] = await Promise.all([
      getMusicLyricResource({ musicInfo }).catch(() => null),
      getCachedLyricInfo(musicInfo),
    ])
    if (remote) {
      let isSave = true
      if (local) {
        if (remote.lyric === local.rawlrcInfo?.lyric) {
          if (!isRefresh) return { info: await buildLyricInfo(local), isFromCache: true }
          isSave = false
        } else if (remote.lyric == local.lyric) {
          isSave = false
        }
      }
      if (isSave) await saveLyricInfo(musicInfo, remote)
      return {
        info: remote,
        isFromCache: false,
      }
    }
    if (!isRefresh && local) {
      return { info: await buildLyricInfo(local), isFromCache: true }
    }
    throw new Error('get lyric info failed')
  }
  return { getMusicUrlByExtSource, getMusicUrl, getMusicPicByExtSource, getMusicPicUrl, getLyricInfoByExtSource, getLyricInfo }
}
export const {
  getMusicUrlByExtSource,
  getMusicUrl,
  getMusicPicByExtSource,
  getMusicPicUrl,
  getLyricInfoByExtSource,
  getLyricInfo,
} = createOnlineMusic(defaultAppState, defaultWorkers, defaultResources)
