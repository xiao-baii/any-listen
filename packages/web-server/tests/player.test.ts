import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'

import { createPlayInfoService } from '../../shared/app/modules/player/playInfo'
import { createPlayTimeStore } from '../../shared/app/modules/player/playTimeStore'
import { createPlayer } from '../../shared/app/modules/player/service'
import type { DBSeriveTypes } from '../../shared/app/modules/worker/utils'
import { STORE_NAMES } from '../../shared/common/constants'
import { createAccountStores } from '../src/accounts/stores'
import { createAppState } from '../src/app/app/state'
import { createMusicSearch } from '../../shared/app/modules/resources/musicSearch'
import { createFallbackSearch } from '../../shared/app/modules/resources/search/music'
import type { ResourceServices } from '../../shared/app/modules/resources/shared'

test('search normalization preserves matching boundaries, versions and candidate order', async () => {
  let songs: AnyListen.Music.MusicInfoOnline[] = []
  let calls = 0
  const services = { extensionSerive: { resourceAction: async () => {
    calls++
    return { list: structuredClone(songs), total: songs.length, page: 2, limit: 7 }
  } } } as unknown as ResourceServices
  const direct = createMusicSearch(services)
  const fallback = createFallbackSearch(services)
  const song = (id: string, interval = '3:00', name = 'Song') => ({
    id, name, singer: 'B、A', interval, isLocal: false, meta: { source: 'test', musicId: id, albumName: '' },
  }) as AnyListen.Music.MusicInfoOnline
  const query = { extensionId: 'test', source: 'test', name: 'Song', singer: 'A、B', albumName: '', interval: '3:00' }
  assert.deepEqual(await direct.musicSearch({ ...query, name: ' ', page: 1 }), { list: [], total: 0, page: 1, limit: 30 })
  assert.deepEqual(await fallback.musicSearch('test', 'test', ' ', '', 1), { list: [], total: 0, page: 1, limit: 10 })
  assert.equal(calls, 0)
  songs = [song('first'), song('second')]
  assert.equal((await direct.findMusic(query))?.id, 'first')
  assert.equal((await fallback.findMusic(query))?.id, 'first')
  const result = await direct.musicSearch({ ...query, page: 2 })
  assert.equal(result.limit, 7)
  assert.equal(result.page, 2)
  songs = [song('boundary', '3:05')]
  assert.equal(await direct.findMusic(query), null)
  assert.equal((await fallback.findMusic(query))?.id, 'boundary')
  assert.equal((await direct.findMusic({ ...query, strict: false }))?.id, 'boundary')
  songs = [song('outside', '3:30')]
  assert.equal(await direct.findMusic({ ...query, strict: false }), null)
  songs = [song('live', '3:00', 'Song (live)')]
  assert.equal((await direct.findMusic(query))?.id, 'live')
  assert.equal(await fallback.findMusic(query), null)
  songs = [song('missing')]
  assert.equal((await direct.findMusic({ extensionId: 'test', source: 'test', name: 'Song' }))?.id, 'missing')
})

const database = () => {
  let saved = {
    index: 0,
    historyIndex: 0,
    time: 0,
    maxTime: 0,
    lastTrackId: null,
    isLinkedList: false,
  } as AnyListen.Player.SavedPlayInfo
  const removed: string[][] = []
  let loads = 0
  const service = {
    async queryMetadataPlayInfo() {
      loads++
      await nextTurn()
      return structuredClone(saved)
    },
    async saveMetadataPlayInfo(info: AnyListen.Player.SavedPlayInfo) {
      await nextTurn()
      saved = structuredClone(info)
    },
    async playListRemove(ids: string[]) {
      removed.push(ids)
      await nextTurn()
    },
  } as unknown as DBSeriveTypes
  return { service, removed, saved: () => saved, loads: () => loads }
}

test('player instances isolate events, progress and database writes and flush before recycling', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'any-listen-players-'))
  const dirs = ['a', 'b'].map((id) => path.join(root, id))
  await Promise.all(dirs.map((dir) => mkdir(dir)))
  await Promise.all(dirs.map((dir, index) => writeFile(path.join(dir, STORE_NAMES.PLAY_TIME), String(index + 10))))
  const aDb = database(),
    bDb = database()
  const a = createPlayer(aDb.service, dirs[0]),
    b = createPlayer(bDb.service, dirs[1])
  try {
    const [first, again, other] = await Promise.all([a.getPlayInfo(), a.getPlayInfo(), b.getPlayInfo()])
    assert.equal(first.time, 10)
    assert.equal(again.time, 10)
    assert.equal(other.time, 11)
    assert.equal(aDb.loads(), 1)
    first.time = 999
    assert.equal((await a.getPlayInfo()).time, 10)
    const aEvents: unknown[] = [],
      bEvents: unknown[] = []
    a.playerEvent.on('playListAction', async (action) => {
      aEvents.push(action)
    })
    b.playerEvent.on('playListAction', async (action) => {
      bEvents.push(action)
    })
    await Promise.all([
      a.playerEvent.playListAction({ action: 'remove', data: ['same-id'] }),
      b.playerEvent.playListAction({ action: 'remove', data: ['b-id'] }),
      a.setPlayTime(101),
      b.setPlayTime(202),
    ])
    await nextTurn()
    assert.deepEqual(aDb.removed, [['same-id']])
    assert.deepEqual(bDb.removed, [['b-id']])
    assert.deepEqual(aEvents, [{ action: 'remove', data: ['same-id'] }])
    assert.deepEqual(bEvents, [{ action: 'remove', data: ['b-id'] }])
    await a.close()
    assert.equal(aDb.saved().time, 0, 'progress-only updates must not rewrite queue metadata')
    assert.equal(await readFile(path.join(dirs[0], STORE_NAMES.PLAY_TIME), 'utf8'), '101')
    await assert.rejects(a.setPlayTime(303), /closed/)
    await assert.rejects(a.playerEvent.playListAction({ action: 'remove', data: [] }), /closed/)
    a.playerEvent.playerAction({ action: 'collectStatus', data: true })
    await nextTurn()
    assert.equal(aEvents.length, 1)
    await b.setPlayTime(203)
    await b.close()
    assert.equal(bDb.saved().time, 0)
    const reopened = createPlayer(aDb.service, dirs[0])
    assert.equal((await reopened.getPlayInfo()).time, 101)
    await reopened.close()
  } finally {
    await Promise.allSettled([a.close(), b.close()])
    await rm(root, { recursive: true, force: true })
  }
})

test('player close waits for both writes and can retry a failed flush', async () => {
  const db = database()
  let fail = true
  let finished = false
  const player = createPlayInfoService(() => db.service, {
    getPlayTime: async () => 0,
    savePlayTime: async () => {
      await nextTurn()
      finished = true
      if (fail) throw new Error('write failed')
    },
  })
  await player.setPlayTime(42)
  await player.setPlayInfo(300)
  await assert.rejects(player.close(), /write failed/)
  assert.equal(finished, true)
  fail = false
  await player.close()
  assert.equal(db.saved().time, 42)
})

test('player close drains accepted queue writes before releasing the database', async () => {
  const db = database()
  let release: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let completed = false
  const player = createPlayer(
    {
      ...db.service,
      playListRemove: async () => {
        await barrier
        completed = true
      },
    },
    ''
  )
  const action = player.playerEvent.playListAction({ action: 'remove', data: ['same-id'] })
  let closed = false
  const closing = player.close().then(() => {
    closed = true
  })
  await nextTurn()
  assert.equal(closed, false)
  release!()
  await Promise.all([action, closing])
  assert.equal(completed, true)
  assert.equal(closed, true)
})

test('progress store serializes concurrent writes and awaits the latest value', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'any-listen-time-'))
  try {
    const store = createPlayTimeStore(() => root)
    await Promise.all(Array.from({ length: 30 }, (_, index) => store.savePlayTime(index)))
    assert.equal(await readFile(path.join(root, STORE_NAMES.PLAY_TIME), 'utf8'), '29')
    assert.equal(await store.getPlayTime(), 29)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('account stores isolate identical names, recover invalid files and release their cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'any-listen-stores-'))
  const a = createAccountStores(path.join(root, 'a'), { error() {}, warn() {} })
  const b = createAccountStores(path.join(root, 'b'), { error() {}, warn() {} })
  try {
    a.get('settings').set('theme', 'a')
    b.get('settings').set('theme', 'b')
    assert.equal(a.get('settings').get('theme'), 'a')
    assert.equal(b.get('settings').get('theme'), 'b')
    await writeFile(path.join(root, 'a', 'broken.json'), 'invalid')
    const repaired = a.get('broken')
    repaired.set('fixed', true)
    assert.equal(a.get('broken'), repaired)
    assert.equal(await readFile(path.join(root, 'a', 'broken.json.bak'), 'utf8'), 'invalid')
    await writeFile(path.join(root, 'a', 'blocked.json'), 'invalid')
    await mkdir(path.join(root, 'a', 'blocked.json.bak'))
    assert.throws(() => a.get('blocked'))
    assert.equal(await readFile(path.join(root, 'a', 'blocked.json'), 'utf8'), 'invalid')
    assert.throws(() => a.get('../b/settings'), /Invalid/)
    a.close()
    assert.throws(() => a.get('settings'), /closed/)
    const reopened = createAccountStores(path.join(root, 'a'), console)
    assert.equal(reopened.get('settings').get('theme'), 'a')
    reopened.close()
  } finally {
    a.close()
    b.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('account application state owns settings, paths and mutable version metadata', () => {
  const a = createAppState(),
    b = createAppState()
  a.appSetting['common.langId'] = 'en-us'
  a.dataPath = 'account-a'
  a.version.status = 'error'
  a.proxy.host = 'account-a'
  assert.notEqual(b.appSetting['common.langId'], 'en-us')
  assert.equal(b.dataPath, '')
  assert.equal(b.version.status, 'idle')
  assert.equal(b.proxy.host, '')
  assert.notEqual(a.appSetting, b.appSetting)
})
