import { sendMusicListAction } from '@any-listen/app/modules/musicList'
import { workers } from '@any-listen/app/modules/worker'
import type Router from '@koa/router'

import { managed } from './managed'

export const validatePersonalData = (value: unknown, depth = 0): void => {
  if (depth > 40) throw new Error('Data is too deeply nested')
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) validatePersonalData(item, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  if (record.type === 'local' || record.type === 'remote' || record.isLocal === true)
    throw new Error('Server file and remote-provider lists cannot be imported')
  for (const [key, item] of Object.entries(record)) {
    if (['__proto__', 'constructor', 'prototype', 'filePath', 'deviceId'].includes(key))
      throw new Error('Unsupported personal data field')
    validatePersonalData(item, depth + 1)
  }
}

export const registerAccountBackup = (router: Router<unknown, AnyListen.RequestContext>,
  database = workers.dbService, sendAction = sendMusicListAction, onlineOnly = managed) => {
  if (!onlineOnly) return
  router.get('/account-backup', async (ctx) => {
    ctx.set('Content-Disposition', 'attachment; filename="any-listen-playlists.json"')
    ctx.body = { format: 'any-listen-personal-v1', songlist: await database.getAllListData() }
  })
  router.post('/account-backup', async (ctx) => {
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of ctx.req) {
      size += chunk.length
      if (size > 16 * 1024 * 1024) {
        ctx.throw(413, 'Backup exceeds 16 MiB')
        return
      }
      chunks.push(chunk)
    }
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString())
      if (data.format !== 'any-listen-personal-v1') throw new Error('Unknown backup format')
      const lists = data.songlist as AnyListen.List.ListDataFull
      if (!lists || lists.defaultList?.id !== 'default' || lists.loveList?.id !== 'love' || !Array.isArray(lists.userList))
        throw new Error('Invalid playlist data')
      const ids = new Set<string>()
      for (const list of [lists.defaultList, lists.loveList, ...lists.userList]) {
        if (
          !list ||
          typeof list.id !== 'string' ||
          !list.id ||
          ids.has(list.id) ||
          typeof list.name !== 'string' ||
          !Array.isArray(list.list) ||
          !list.meta ||
          !['default', 'general', 'online'].includes(list.type)
        )
          throw new Error('Invalid playlist')
        ids.add(list.id)
        for (const music of list.list)
          if (!music || typeof music.id !== 'string' || typeof music.name !== 'string' || !music.meta || music.isLocal !== false)
            throw new Error('Invalid song')
      }
      validatePersonalData(lists)
      await sendAction({ action: 'list_data_overwrite', data: lists })
      ctx.body = { ok: true }
    } catch (error) {
      ctx.throw(400, (error as Error).message)
    }
  })
}
