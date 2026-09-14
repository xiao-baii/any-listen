import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Worker } from 'node:worker_threads'

import { DatabaseContext, databaseState, getManagedDatabaseContexts } from '../../shared/app/modules/worker/dbService/context'
import { trimMusicListCache } from '../../shared/app/modules/worker/dbService/modules/music_library'
import { createAccountDatabase } from '../../shared/app/modules/worker/dbService/service'
import { LIST_IDS } from '../../shared/common/constants'
import { SharedDatabase } from '../src/accounts/sharedDatabase'

test('database contexts retain their own state across interleaved asynchronous work', async () => {
  const a = new DatabaseContext(true)
  const b = new DatabaseContext(true)
  const state = () => databaseState('test', () => ({ value: '' }))
  await Promise.all([
    a.run(async () => {
      state().value = 'a'
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(state().value, 'a')
    }),
    b.run(async () => {
      state().value = 'b'
      await Promise.resolve()
      assert.equal(state().value, 'b')
    }),
  ])
  a.close()
  assert.throws(() => a.run(state), /closed/)
  assert.equal(b.run(state).value, 'b')
  b.close()
})

test('managed playlist caches share a global budget and release closed accounts', () => {
  const contexts = Array.from({ length: 10 }, () => new DatabaseContext(true))
  const caches = contexts.map((context) => context.run(() => databaseState('music_library/index.ts', () => ({
    musicLists: new Map<string, AnyListen.Music.MusicInfo[]>(),
  })).musicLists))
  const song = { id: 'same-id' } as AnyListen.Music.MusicInfo
  try {
    contexts.forEach((context, index) => context.run(() => {
      caches[index].set('same-list', Array.from({ length: 2000 }, () => song))
      trimMusicListCache()
    }))
    assert.equal(caches.reduce((sum, cache) => sum + [...cache.values()].reduce((n, list) => n + list.length, 0), 0), 16000)
    assert.equal(caches[0].size, 0)
    assert.equal(caches[1].size, 0)
    assert.equal(caches[9].get('same-list')?.length, 2000)
    contexts.forEach((context, index) => context.run(() => {
      caches[index].clear()
      for (let n = 0; n < 8; n++) caches[index].set(String(n), [])
      trimMusicListCache()
    }))
    assert.equal(caches.reduce((sum, cache) => sum + cache.size, 0), 64)
  } finally {
    contexts.forEach((context) => context.close())
  }
  for (const context of getManagedDatabaseContexts()) assert(!contexts.includes(context))
})

test('one worker serves separate account channels and closes pending clients', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'any-listen-db-worker-'))
  const require = createRequire(path.join(process.env.ACCOUNT_TEST_ROOT!, 'packages/shared/app/package.json'))
  const binding = require(path.join(path.dirname(require.resolve('better-sqlite3')), 'binding.js')).getPrebuildPath()
  const host = new SharedDatabase(path.join(__dirname, 'database.worker.cjs'))
  try {
    const dirs = ['a', 'b'].map((name) => path.join(root, name))
    await Promise.all(dirs.map((dir) => mkdir(dir)))
    await assert.rejects(host.open(path.join(root, 'missing', 'account'), binding, 'invalid'))
    const [a, b] = await Promise.all(dirs.map((dir) => host.open(dir, binding, dir)))
    assert.deepEqual(host.status(), { workers: 1, channels: 2 })
    const saturated = Array.from({ length: 128 }, () => a.service.queryMetadataPlayListInfo())
    await assert.rejects(a.service.queryMetadataPlayListInfo(), /queue is full/)
    await Promise.all(saturated)
    await a.service.saveMetadataPlayListInfo('a-list', 'search')
    await b.service.saveMetadataPlayListInfo('b-list', 'songlist')
    assert.equal((await a.service.queryMetadataPlayListInfo()).listId, 'a-list')
    assert.equal((await b.service.queryMetadataPlayListInfo()).listId, 'b-list')
    const writes = Array.from({ length: 20 }, (_, index) => a.service.saveMetadataPlayListInfo(`a-${index}`, 'search'))
    const closing = a.close()
    await assert.rejects(a.service.queryMetadataPlayListInfo(), /closed/)
    await Promise.all(writes)
    await closing
    const reopened = await host.open(dirs[0], binding, 'a')
    assert.equal((await reopened.service.queryMetadataPlayListInfo()).listId, 'a-19')
    await reopened.close()
    assert.equal((await b.service.queryMetadataPlayListInfo()).listId, 'b-list')
    const disconnected = assert.rejects(b.closed, /disconnected/)
    const worker = (host as unknown as { worker: Worker }).worker
    await worker.terminate()
    await disconnected
    await assert.rejects(b.service.queryMetadataPlayListInfo(), /closed/)
    const recovered = await host.open(dirs[1], binding, 'b')
    assert.equal((await recovered.service.queryMetadataPlayListInfo()).listId, 'b-list')
    assert.deepEqual(host.status(), { workers: 1, channels: 1 })
    await recovered.close()
    await host.close()
    assert.deepEqual(host.status(), { workers: 0, channels: 0 })
    await assert.rejects(host.open(dirs[0], binding, 'a'), /closed/)
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('two account databases isolate identical song ids, queues and metadata and survive reopening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'any-listen-db-'))
  const require = createRequire(path.join(process.env.ACCOUNT_TEST_ROOT!, 'packages/shared/app/package.json'))
  const bindingModule = require(path.join(path.dirname(require.resolve('better-sqlite3')), 'binding.js'))
  const binding = bindingModule.getPrebuildPath() as string
  const open = async (name: string) => {
    const dir = path.join(root, name)
    await mkdir(dir, { recursive: true })
    return createAccountDatabase(dir, binding, name)
  }
  let a: Awaited<ReturnType<typeof open>> | undefined
  let b: Awaited<ReturnType<typeof open>> | undefined
  const song = (name: string) =>
    ({ id: 'same-id', name, singer: 'artist', isLocal: false, interval: null, meta: {} }) as AnyListen.Music.MusicInfo
  try {
    ;[a, b] = await Promise.all([open('a'), open('b')])
    a.service.musicOverwrite(LIST_IDS.DEFAULT, [song('a')])
    b.service.musicOverwrite(LIST_IDS.DEFAULT, [song('b')])
    assert.equal(a.service.getListMusics(LIST_IDS.DEFAULT)[0].name, 'a')
    assert.equal(b.service.getListMusics(LIST_IDS.DEFAULT)[0].name, 'b')
    a.service.saveMetadataPlayInfo({ ...a.service.queryMetadataPlayInfo(), time: 42 })
    assert.equal(b.service.queryMetadataPlayInfo().time, 0)
    a.service.playListOverride([
      { itemId: 'same-item', musicInfo: song('a'), listId: LIST_IDS.DEFAULT, source: 'search', played: false, playLater: false },
    ])
    assert.equal(b.service.getPlayList().length, 0)
    assert.equal(a.service.getPlayList()[0].musicInfo.name, 'a')
    const largeList = Array.from({ length: 2001 }, (_, index) => ({ ...song(`track-${index}`), id: `id-${index}` }))
    a.service.musicOverwrite(LIST_IDS.DEFAULT, largeList)
    const firstRead = a.service.getListMusics(LIST_IDS.DEFAULT)
    assert.notEqual(a.service.getListMusics(LIST_IDS.DEFAULT), firstRead, 'oversized playlists must not remain cached')
    assert.equal(a.service.getListMusicsByIds(LIST_IDS.DEFAULT, ['id-2000'])[0].name, 'track-2000')
    a.service.musicsClear([LIST_IDS.DEFAULT])
    assert.equal(a.service.getAllUserLists().defaultList.meta.songCount, 0)
    a.service.musicOverwrite(LIST_IDS.DEFAULT, [song('a')])
    a.close()
    assert.throws(() => a!.service.getPlayList(), /closed/)
    a = await open('a')
    assert.equal(a.service.getListMusics(LIST_IDS.DEFAULT)[0].name, 'a')
    assert.equal(a.service.queryMetadataPlayInfo().time, 42)
    assert.equal(a.service.getPlayList()[0].musicInfo.name, 'a')
    assert.equal(b.service.getListMusics(LIST_IDS.DEFAULT)[0].name, 'b')
    a.close()
    a = await open('a')
    a.service.playListClear()
    assert.deepEqual(a.service.getPlayList(), [], 'clear must work before the persisted queue has been loaded')
  } finally {
    a?.close()
    b?.close()
    await rm(root, { recursive: true, force: true })
  }
})
