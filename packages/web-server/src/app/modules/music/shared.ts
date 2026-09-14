import { existTimeExp } from '@any-listen/app/modules/music/utils'

import { appState as defaultAppState } from '@/app/app/state'
import { workers as defaultWorkers } from '@any-listen/app/modules/worker'

export const createMusicCache = (
  appState: typeof defaultAppState,
  workers: Pick<typeof defaultWorkers, 'dbService' | 'utilService'>
) => {
  const getCachedLyricInfo = async (musicInfo: AnyListen.Music.MusicInfo): Promise<AnyListen.Music.LyricInfo | null> => {
    let lrcInfo = await workers.dbService.getPlayerLyric(musicInfo.id)
    // lrcInfo = {} as unknown as AnyListen.Player.LyricInfo
    if (existTimeExp.test(lrcInfo.lyric)) {
      return lrcInfo
    }
    return null
  }

  const saveLyricInfo = async (musicInfo: AnyListen.Music.MusicInfo, info: AnyListen.Music.LyricInfo) => {
    await workers.dbService.rawLyricSave(musicInfo.id, info)
  }

  const buildLyricInfo = async (lyricInfo: AnyListen.Music.LyricInfo): Promise<AnyListen.Music.LyricInfo> => {
    if (appState.appSetting['player.isS2t']) {
      return workers.utilService.lyricS2T(lyricInfo)
    }
    return lyricInfo
  }
  return { getCachedLyricInfo, saveLyricInfo, buildLyricInfo }
}
export const { getCachedLyricInfo, saveLyricInfo, buildLyricInfo } = createMusicCache(defaultAppState, defaultWorkers)
