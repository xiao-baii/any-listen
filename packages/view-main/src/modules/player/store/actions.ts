import { createPlayMusicInfoList } from '@any-listen/common/tools'

import { showMusicCommentModal } from '@/components/apis/musicCommentModal'
import { onDesconnected } from '@/modules/app/shared'
import { i18n } from '@/plugins/i18n'

import * as commit from './commit'
import { playerEvent } from './event'
import { addPlayListMusic } from './listRemoteAction'
import { playerState } from './state'

export const initPlayList = (list: AnyListen.Player.PlayMusicInfo[]) => {
  commit.setPlayListMusic(list)
}

export {
  setPlayHistoryList as initPlayHistoryList,
  setDislikeIds,
  setIsLinkedList,
  setMaxPlayTime,
  setNowPlayTime,
  setPlayerPlaying,
  setPlayListId,
  setPlaybackRate as setStatePlaybackRate,
  setVolume as setStateVolume,
  setVolumeMute as setStateVolumeMute,
  setStatusText,
  updatePlayHistoryIndex,
  setMusicInfo,
  updatePlayIndex,
  initPlayInfo,
  setInited,
} from './commit'

export {
  addPlayListMusic,
  registerRemoteListAction,
  removePlayListMusic,
  setPlayListMusic,
  setPlayListMusicPlayed,
  setPlayListMusicUnplayed,
  setPlayListMusicUnplayedAll,
  updatePlayListMusic,
  updatePlayListMusicPos,
} from './listRemoteAction'

export {
  getMusicPicDelay,
  getPlayInfo,
  registerLocalPlayerAction,
  registerRemoteHistoryListAction,
  registerRemotePlayerAction,
} from './playerRemoteAction'

export {
  collectMusic,
  dislikeMusic,
  pause,
  play,
  playId,
  playIndex,
  playList,
  playOnlineList,
  release,
  seekTo,
  setCollectStatus,
  setLyricOffset,
  setMusicUrl,
  setPlaybackRate,
  setPlayMusicInfo,
  setVolume,
  setVolumeMute,
  skipNext,
  skipPrev,
  stop,
  togglePlay,
  uncollectMusic,
  checkCollectMusic,
} from './playerActions'

export const addPlayLaterMusic = async (
  musicInfos: AnyListen.Music.MusicInfo[],
  listId: string,
  source: AnyListen.Player.SourceType = 'local',
  isTop = false
) => {
  if (!musicInfos.length) return
  const list = createPlayMusicInfoList({
    musicInfos,
    listId,
    source,
    playLater: true,
  })
  let pos = 0
  if (!isTop) {
    const firstRegularIndex = playerState.playList.findIndex((m) => !m.playLater)
    pos = firstRegularIndex === -1 ? playerState.playList.length : firstRegularIndex
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      unsubscribeAdded()
      unsubscribeDisconnected()
      clearTimeout(timer)
      complete()
    }
    const fail = (error: unknown) => finish(() => reject(error))
    const unsubscribeAdded = playerEvent.on('playListMusicAdded', (_pos, added) => {
      if (added.length === list.length && added.every((music, index) => music.itemId === list[index].itemId)) {
        finish(resolve)
      }
    })
    const unsubscribeDisconnected = onDesconnected(() => {
      fail(new Error(i18n.t('user_list_music_menu__play_later_disconnected')))
    })
    const timer = setTimeout(() => {
      fail(new Error(i18n.t('user_list_music_menu__play_later_unconfirmed')))
    }, 30_000)
    void addPlayListMusic({ musics: list, pos }).catch(fail)
  })
}

export const sendCreatedEvent = () => {
  playerEvent.created()
}

export {
  getHasMediaDevicePermission,
  getMediaDeviceIdSetting,
  saveMediaDeviceIdSetting,
  setHasMediaDevicePermission,
  getMediaDevices,
} from './mediaDevice'

export const showMusicComment = async () => {
  const musicInfo = playerState.playMusicInfo?.musicInfo
  if (!musicInfo) return
  await showMusicCommentModal(musicInfo, () => {
    return playerState.playMusicInfo?.musicInfo || null
  })
}
