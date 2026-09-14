import { databaseState } from '../../context'

const getState = () => databaseState('metadata/playInfo.ts', () => ({
  playInfo: undefined as AnyListen.Player.SavedPlayInfo | undefined,
}))

import { dbPrepare } from '../../db'


const init = () => {
  if (getState().playInfo !== undefined) return
  const result = dbPrepare<[], { field_value: string }>(`
    SELECT "field_value"
    FROM "main"."metadata"
    WHERE "field_name"='play_info'
  `).get()
  const data = result?.field_value
  if (data) {
    try {
      const result = JSON.parse(data) as AnyListen.Player.SavedPlayInfo
      getState().playInfo = result
      return
    } catch {}
  }
  getState().playInfo = {
    index: -1,
    time: 0,
    maxTime: 0,
    historyIndex: -1,
    lastTrackId: null,
    isLinkedList: true,
  }
}
/**
 * 获取播放信息
 */
export const queryMetadataPlayInfo = () => {
  init()
  return getState().playInfo!
}
/**
 * 保存播放信息
 * @param info
 */
export const saveMetadataPlayInfo = (info: AnyListen.Player.SavedPlayInfo) => {
  getState().playInfo = info
  dbPrepare<string>(
    `
    INSERT INTO "main"."metadata" ("field_name", "field_value")
    VALUES ('play_info', ?)
  `
  ).run(JSON.stringify(getState().playInfo))
}
