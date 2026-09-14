import { databaseState } from '../../context'

const getState = () => databaseState('metadata/playHistoryList.ts', () => ({
  playHistoryList: undefined as AnyListen.IPCPlayer.PlayHistoryListItem[] | undefined,
}))

import { arrPush } from '@any-listen/common/utils'

import { dbPrepare } from '../../db'


const initPlayHistoryList = () => {
  if (getState().playHistoryList) return
  const result = dbPrepare<[], { field_value: string }>(`
    SELECT "field_value"
    FROM "main"."metadata"
    WHERE "field_name"='play_history_list'
  `).get() as { field_value: string } | null

  if (!result) {
    dbPrepare(`
      INSERT INTO "main"."metadata" ("field_name", "field_value")
      VALUES ('play_history_list', '[]')
    `).run()
    getState().playHistoryList = []
    return
  }
  try {
    getState().playHistoryList = (JSON.parse(result.field_value) as AnyListen.IPCPlayer.PlayHistoryListItem[] | null) ?? []
  } catch (e) {
    getState().playHistoryList = []
  }
}
const savePlayHistoryList = () => {
  dbPrepare<string>(`
    UPDATE "main"."metadata"
    SET "field_value"=?
    WHERE "field_name"='play_history_list'
  `).run(JSON.stringify(getState().playHistoryList))
}
/**
 * 获取播放历史列表
 */
export const queryMetadataPlayHistoryList = () => {
  initPlayHistoryList()
  return getState().playHistoryList!
}

/**
 * 覆盖播放历史列表
 */
export const setMetadataPlayHistoryList = (ids: AnyListen.IPCPlayer.PlayHistoryListItem[]) => {
  initPlayHistoryList()
  if (!getState().playHistoryList!.length && !ids.length) return
  getState().playHistoryList = ids
  savePlayHistoryList()
}

/**
 * 添加播放历史列表
 */
export const addMetadataPlayHistoryList = (ids: AnyListen.IPCPlayer.PlayHistoryListItem[]) => {
  initPlayHistoryList()
  arrPush(getState().playHistoryList!, ids)
  savePlayHistoryList()
}

/**
 * 添加播放历史列表
 */
export const removeMetadataPlayHistoryList = (idxs: number[]) => {
  initPlayHistoryList()
  idxs.sort((a, b) => b - a)
  for (const idx of idxs) getState().playHistoryList!.splice(idx, 1)
  savePlayHistoryList()
}
