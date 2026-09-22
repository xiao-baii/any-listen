import { onRelease } from '@/modules/app/shared'
import {
  getErrorCode,
  onCanplay,
  onEmptied,
  onEnded,
  onError,
  onLoadeddata,
  onLoadstart,
  onPause,
  onPlaying,
  onWaiting,
} from '@/plugins/player'
import { createUnsubscriptionSet } from '@/shared'

import { onPlayerCreated } from '../shared'
import { playerEvent } from '../store/event'

let unregistered = createUnsubscriptionSet()
export const initPlayerEvent = () => {
  onRelease(unregistered.clear.bind(unregistered))
  onPlayerCreated(() => {
    unregistered.register((unregistered) => {
      unregistered.add(
        onPlaying(() => {
          playerEvent.playerPlaying()
          playerEvent.play()
        })
      )
      unregistered.add(
        onPause(() => {
          playerEvent.playerPause()
          playerEvent.pause()
        })
      )
      unregistered.add(
        onEnded(() => {
          playerEvent.playerEnded()
          // playerEvent.pause()
        })
      )
      unregistered.add(
        onError(() => {
          const errorCode = getErrorCode()
          playerEvent.error(errorCode)
          playerEvent.playerError(errorCode)
        })
      )
      unregistered.add(
        onLoadeddata(() => {
          playerEvent.playerLoadeddata()
        })
      )
      unregistered.add(
        onLoadstart(() => {
          playerEvent.playerLoadstart()
        })
      )
      unregistered.add(
        onCanplay(() => {
          playerEvent.playerCanplay()
        })
      )
      unregistered.add(
        onEmptied(() => {
          playerEvent.playerEmptied()
          // playerEvent.stop()
        })
      )
      unregistered.add(
        onWaiting(() => {
          playerEvent.pause()
          playerEvent.playerWaiting()
        })
      )
    })
  })
}
