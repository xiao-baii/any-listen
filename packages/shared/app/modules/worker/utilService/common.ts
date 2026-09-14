import { simplify, tranditionalize } from './shared/simplify-chinese-main'

export const langS2T = (rawText: string): string => {
  const text = tranditionalize(rawText)
  return text
}

export const langT2S = (rawText: string): string => {
  const text = simplify(rawText)
  return text
}

export const lyricS2T = async (lyricInfo: AnyListen.Music.LyricInfo) => {
  lyricInfo.lyric &&= langS2T(lyricInfo.lyric)
  lyricInfo.tlyric &&= langS2T(lyricInfo.tlyric)
  lyricInfo.rlyric &&= langS2T(lyricInfo.rlyric)
  lyricInfo.awlyric &&= langS2T(lyricInfo.awlyric)
  if (lyricInfo.rawlrcInfo) {
    lyricInfo.rawlrcInfo.lyric &&= langS2T(lyricInfo.rawlrcInfo.lyric)
    lyricInfo.rawlrcInfo.tlyric &&= langS2T(lyricInfo.rawlrcInfo.tlyric)
    lyricInfo.rawlrcInfo.rlyric &&= langS2T(lyricInfo.rawlrcInfo.rlyric)
    lyricInfo.rawlrcInfo.awlyric &&= langS2T(lyricInfo.rawlrcInfo.awlyric)
  }
  return lyricInfo
}

// export {
//   saveAnyListenConfigFile,
//   readAnyListenConfigFile,
//   saveStrToFile,
// } from '@common/utils/nodejs'
