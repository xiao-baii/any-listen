import { dbPrepare } from '../../db'

interface PlayListInfo {
  singerQueue?: AnyListen.Player.SingerQueue
  listId: null | string
  source: AnyListen.Player.SourceType
}

export const queryMetadataPlayListInfo = (): PlayListInfo => {
  const result = dbPrepare<[], { field_value: string }>(`
    SELECT "field_value"
    FROM "main"."metadata"
    WHERE "field_name"='play_list_id'
  `).get()
  const data = result?.field_value
  if (data) {
    try {
      const result = JSON.parse(data) as PlayListInfo
      if (typeof result != 'object') throw new Error('not object')
      if ((result as unknown as { isOnline: boolean }).isOnline) {
        // 兼容旧版本，在线列表不再保存 source 字段
        result.source = (result as unknown as { isOnline: boolean }).isOnline ? 'songlist' : 'local'
        delete (result as unknown as { isOnline?: boolean }).isOnline
      }
      return result
    } catch {}
  }
  return {
    listId: null,
    source: 'local',
  }
}
export const saveMetadataPlayListInfo = (
  listId: string | null,
  source: AnyListen.Player.SourceType,
  singerQueue?: AnyListen.Player.SingerQueue
) => {
  dbPrepare<string>(`
    INSERT INTO "main"."metadata" ("field_name", "field_value")
    VALUES ('play_list_id', ?)
  `).run(JSON.stringify({ listId, source, singerQueue }))
}
