import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import WebSocket from 'ws'

import { createOnlineListSync } from '../../shared/app/modules/musicList/onlineSync'
import { createMusicList } from '../../shared/app/modules/musicList/service'
import { createProxyService } from '../../shared/app/modules/proxyServer'
import { createResources } from '../../shared/app/modules/resources/service'
import type { ExtensionSeriveTypes } from '../../shared/app/modules/worker/utils'
import type { DBSeriveTypes } from '../../shared/app/modules/worker/utils'
import { createSocketEvent } from '../src/modules/ipc/event'
import { createSocketService } from '../src/modules/ipc/socketService'

test('socket instances isolate broadcasts and revoke every device of only the owning account', async () => {
  const aEvent = createSocketEvent(),
    bEvent = createSocketEvent()
  const authorize = async () => ({ clientId: 'same-session', timestamp: Date.now() })
  const a = createSocketService(aEvent, authorize, () => {}, console)
  const b = createSocketService(bEvent, authorize, () => {}, console)
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => (req.url!.startsWith('/a') ? a : b).onUpgrade(req, socket as Socket, head))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const clients: WebSocket[] = []
  try {
    for (const id of ['a', 'a', 'b']) {
      const client = new WebSocket(`ws://127.0.0.1:${port}/${id}?t=main`)
      clients.push(client)
      await once(client, 'open')
    }
    await nextTurn()
    assert.equal(a.getSockets().length, 2)
    assert.equal(b.getSockets().length, 1)
    const sent: unknown[] = []
    a.broadcast((socket) => sent.push(socket))
    assert.equal(sent.length, 2)
    assert.ok(!sent.includes(b.getSockets()[0]))
    const revoked = clients.slice(0, 2).map((client) => once(client, 'close'))
    aEvent.remove_session('same-session')
    await Promise.all(revoked)
    assert.equal(clients[2].readyState, WebSocket.OPEN)
    a.close()
    const message = once(clients[2], 'message')
    b.broadcast((socket) => socket.sendMessage({ account: 'b' }))
    assert.equal(JSON.parse(String((await message)[0])).account, 'b')
  } finally {
    for (const client of clients) client.terminate()
    a.close()
    b.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const music = (id: string) => ({ id, name: id, isLocal: false, meta: {} }) as AnyListen.Music.MusicInfoOnline

test('resource instances retain their own service and source selection across interleaved calls', async () => {
  const calls: string[] = []
  const make = (id: string) =>
    createResources(
      {
        resourceAction: async (action: string, params: { extensionId: string; page?: number }) => {
          await nextTurn()
          assert.equal(params.extensionId, id)
          calls.push(id)
          if (action === 'musicUrl') return { url: `https://example.org/${id}.mp3` }
          return { list: [music(`${id}-${params.page}`)], total: 2, limit: 1, page: params.page }
        },
      } as unknown as ExtensionSeriveTypes,
      { resources: { musicUrl: [{ extensionId: id, id: 'test', name: id }] } }
    )
  const a = make('a'),
    b = make('b')
  const info = music('same')
  info.meta.source = 'test'
  const [aUrl, bUrl, aList, bList] = await Promise.all([
    a.getMusicUrl({ musicInfo: info }),
    b.getMusicUrl({ musicInfo: info }),
    a.songlistDetailAll('a', 'test', 'same'),
    b.songlistDetailAll('b', 'test', 'same'),
  ])
  assert.equal(aUrl.url, 'https://example.org/a.mp3')
  assert.equal(bUrl.url, 'https://example.org/b.mp3')
  assert.deepEqual(
    aList.map((item) => item.id),
    ['a-1', 'a-2']
  )
  assert.deepEqual(
    bList.map((item) => item.id),
    ['b-1', 'b-2']
  )
  a.close()
  await assert.rejects(a.hotSearch({ extensionId: 'a', source: 'test' }), /closed/)
  await b.getMusicUrl({ musicInfo: info })
  assert.equal(calls.at(-1), 'b')
  b.close()
})
const database = (name: string) => {
  let tracks = [music(name), music('second')]
  let list = {
    id: 'same',
    name,
    type: 'online',
    meta: { sourceType: 'songlist', source: 'test', extensionId: 'public', syncId: name },
  } as AnyListen.List.OnlineListInfo
  const writes: unknown[] = []
  let covers = 0
  const service = {
    async getAllUserLists() {
      return { userList: [structuredClone(list)] }
    },
    async getListInfos() {
      return [structuredClone(list)]
    },
    async getListMusics() {
      return structuredClone(tracks)
    },
    async getListsFirstMusics(ids: string[]) {
      covers++
      return ids.map(() => [music(name)])
    },
    async createUserLists(_position: number, items: AnyListen.List.OnlineListInfo[]) {
      list = structuredClone(items[0])
      tracks = []
    },
    async updateUserLists(items: AnyListen.List.OnlineListInfo[]) {
      list = structuredClone(items[0])
    },
    async musicOverwrite(id: string, items: AnyListen.Music.MusicInfoOnline[]) {
      await nextTurn()
      tracks = structuredClone(items)
      writes.push([id, items])
    },
    async commitOnlineListSync(snapshot: AnyListen.List.OnlineListInfo, items: AnyListen.Music.MusicInfoOnline[], automatic: boolean) {
      if (!isDeepStrictEqual(list, snapshot) || (automatic && !list.meta.autoSync)) return { status: 'stale' }
      let musicInfos: typeof tracks | undefined
      if (tracks.length !== items.length || items.some((item, index) => item.id !== tracks[index]?.id)) {
        musicInfos = items
        tracks = structuredClone(items)
        writes.push([list.id, items])
      }
      list = { ...list, meta: { ...list.meta, songCount: tracks.length, syncTime: Date.now() } }
      return { status: 'applied', list: structuredClone(list), musicInfos }
    },
  } as unknown as DBSeriveTypes
  return { service, writes, covers: () => covers, tracks: () => tracks, list: () => list }
}

test('playlist instances isolate events, identical IDs, cover caches and deferred scroll saves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const aDb = database('a'),
    bDb = database('b')
  let aScroll: Record<string, number> = {},
    bScroll: Record<string, number> = {}
  let loads = 0
  const a = createMusicList(
    aDb.service,
    async () => {
      loads++
      await nextTurn()
      return aScroll
    },
    async (info) => {
      await nextTurn()
      aScroll = info
    }
  )
  const b = createMusicList(
    bDb.service,
    async () => bScroll,
    async (info) => {
      bScroll = info
    }
  )
  const seenA: unknown[] = [],
    seenB: unknown[] = []
  a.onMusicListAction(async (action) => {
    seenA.push(action)
  })
  b.onMusicListAction(async (action) => {
    seenB.push(action)
  })
  const picture = async ({ musicInfo }: { musicInfo: AnyListen.Music.MusicInfo }) => ({ url: musicInfo.name })
  try {
    await Promise.all([
      a.saveListScrollPosition('same', 1),
      a.saveListScrollPosition('second', 2),
      b.saveListScrollPosition('same', 9),
    ])
    assert.equal(loads, 1)
    assert.deepEqual(await a.getListScrollInfo(), { same: 1, second: 2 })
    assert.equal((await a.getListsCover(['same'], picture)).same, 'a')
    assert.equal((await b.getListsCover(['same'], picture)).same, 'b')
    await a.sendMusicListAction({ action: 'list_music_overwrite', data: { listId: 'same', musicInfos: [music('new-a')] } })
    await nextTurn()
    assert.equal(seenA.length, 1)
    assert.equal(seenB.length, 0)
    assert.equal(bDb.writes.length, 0)
    await a.getListsCover(
      Array.from({ length: 129 }, (_, i) => String(i)),
      picture
    )
    const before = aDb.covers()
    await a.getListsCover(['0'], picture)
    assert.equal(aDb.covers(), before + 1, 'old covers must be evicted')
    await a.close()
    assert.deepEqual(aScroll, { same: 1, second: 2 })
    await assert.rejects(a.saveListScrollPosition('same', 5), /closed/)
    await b.saveListScrollPosition('same', 10)
    await b.close()
    assert.deepEqual(bScroll, { same: 10 })
  } finally {
    await Promise.allSettled([a.close(), b.close()])
  }
})

test('playlist close drains writes accepted before closure and retries failed scroll persistence', async () => {
  const db = database('a')
  let fail = true
  let saved: unknown
  const list = createMusicList(
    db.service,
    async () => ({}),
    async (info) => {
      await nextTurn()
      if (fail) throw new Error('disk failed')
      saved = info
    }
  )
  const scroll = list.saveListScrollPosition('same', 42)
  const write = list.sendMusicListAction({ action: 'list_music_overwrite', data: { listId: 'same', musicInfos: [] } })
  await assert.rejects(list.close(), /disk failed/)
  await Promise.all([scroll, write])
  assert.equal(db.writes.length, 1)
  fail = false
  await list.close()
  assert.deepEqual(saved, { same: 42 })
})

test('closing a playlist service waits for its count read and cancels subsequent notifications', async (t) => {
  const db = database('a')
  let reads = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  t.mock.method(db.service, 'getListInfos', async () => {
    reads++
    await gate
    return [db.list()]
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lists = createMusicList(db.service, async () => ({}), async () => {})
  const events: string[] = []
  lists.onMusicListAction(async (action) => { events.push(action.action) })
  const overwrite: AnyListen.IPCList.ActionList = { action: 'list_music_overwrite', data: { listId: 'same', musicInfos: [] } }
  try {
    await lists.sendMusicListAction(overwrite)
    t.mock.timers.tick(500)
    await lists.sendMusicListAction(overwrite)
    t.mock.timers.tick(1000)
    await nextTurn()
    assert.equal(reads, 1)
    let closed = false
    const closing = lists.close().then(() => { closed = true })
    await nextTurn()
    assert.equal(closed, false)
    release()
    await closing
    t.mock.timers.tick(1000)
    assert.equal(reads, 1)
    assert.deepEqual(events, ['list_music_overwrite', 'list_music_overwrite'])
  } finally {
    release()
    await lists.close()
  }
})

test('online sync isolates tenants, removes trailing songs and persists sync time', async () => {
  const aDb = database('a'),
    bDb = database('b')
  const a = createMusicList(
    aDb.service,
    async () => ({}),
    async () => {}
  )
  const b = createMusicList(
    bDb.service,
    async () => ({}),
    async () => {}
  )
  const errors: unknown[] = []
  const aEvents: string[] = []
  a.onMusicListAction(async (action) => { aEvents.push(action.action) })
  const aSync = createOnlineListSync(
    a,
    async () => [music('a')],
    (error) => errors.push(error)
  )
  const bSync = createOnlineListSync(
    b,
    async () => [music('b')],
    (error) => errors.push(error)
  )
  try {
    await Promise.all([aSync.syncList(aDb.list()), bSync.syncList(bDb.list())])
    await aSync.syncList(aDb.list())
    await nextTurn()
    assert.deepEqual(
      aDb.tracks().map((item) => item.id),
      ['a']
    )
    assert.deepEqual(
      bDb.tracks().map((item) => item.id),
      ['b']
    )
    assert.ok(aDb.list().meta.syncTime)
    assert.equal(aDb.list().meta.songCount, 1)
    assert.ok(bDb.list().meta.syncTime)
    assert.equal(aDb.writes.length, 1)
    assert.deepEqual(aEvents, ['list_music_overwrite', 'list_update', 'list_update'])
    assert.deepEqual(errors, [])
    await assert.rejects(aSync.syncList({ ...aDb.list(), id: 'removed' }), /Not an online list/)
    aSync.start()
    await aSync.close()
    await assert.rejects(aSync.syncList(aDb.list()), /closed/)
    await bSync.syncAllList()
  } finally {
    await Promise.all([aSync.close(), bSync.close()])
    await Promise.all([a.close(), b.close()])
  }
})

test('online sync close waits for in-flight resolution without writing stale results', async () => {
  const db = database('a')
  const list = createMusicList(
    db.service,
    async () => ({}),
    async () => {}
  )
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const sync = createOnlineListSync(
    list,
    async () => {
      calls++
      await barrier
      return []
    },
    () => {}
  )
  const task = sync.syncList(db.list())
  assert.equal(sync.syncList(db.list()), task)
  const rejected = assert.rejects(task, /Online list sync is closed/)
  await nextTurn()
  let closed = false
  const closing = sync.close().then(() => {
    closed = true
  })
  await nextTurn()
  assert.equal(closed, false)
  release()
  await Promise.all([rejected, closing])
  assert.equal(calls, 1)
  assert.equal(db.writes.length, 0)
  await list.close()
})

test('resource proxy instances isolate keys and cached files and cancel only their own streams', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'any-listen-proxy-'))
  const a = createProxyService(),
    b = createProxyService()
  try {
    await Promise.all([a.initProxyServer('.', '/a', path.join(root, 'a')), b.initProxyServer('.', '/b', path.join(root, 'b'))])
    assert.notEqual(await a.getProxyUrlKey(), await b.getProxyUrlKey())
    const url = await a.writeProxyCache('song.mp3', Buffer.from('0123456789'))
    const name = url.slice(url.lastIndexOf('/') + 1)
    assert.equal(await b.proxyRequest(name), null)
    const stream = await a.proxyRequest(name, { range: 'bytes=2-4' })
    assert.equal(stream?.statusCode, 206)
    assert.equal(stream?.headers['content-length'], '3')
    await a.close()
    assert.equal(stream?.body?.destroyed, true)
    await assert.rejects(a.proxyRequest(name), /closed/)
    const bUrl = await b.writeProxyCache('song.mp3', Buffer.from('b'))
    const result = await b.proxyRequest(bUrl.slice(bUrl.lastIndexOf('/') + 1))
    assert.equal(result?.statusCode, 200)
    result?.body?.destroy()
  } finally {
    await Promise.all([a.close(), b.close()])
    await nextTurn()
    await rm(root, { recursive: true, force: true })
  }
})


test('collecting a remote playlist fetches once, with automatic sync off by default', async () => {
  const db = database('initial')
  const current = () => db.list()
  const initial = { ...current(), meta: { ...current().meta, extensionId: '', autoSync: false } }
  await db.service.updateUserLists([initial])
  let calls = 0
  let fail = false
  const handlers = new Map<string, (...args: any[]) => void>()
  const lists = {
    getAllUserLists: db.service.getAllUserLists,
    commitOnlineListSync: db.service.commitOnlineListSync,
    musicListEvent: { on: (name: string, callback: (...args: any[]) => void) => { handlers.set(name, callback); return () => handlers.delete(name) } },
  } as unknown as Parameters<typeof createOnlineListSync>[0]
  const sync = createOnlineListSync(lists, async () => {
    calls++
    if (fail) throw new Error('source failed')
    return [music('new')]
  }, () => {})
  try {
    await sync.syncAllList()
    handlers.get('list_create')!(0, [current()])
    await nextTurn()
    assert.equal(calls, 0)
    current().meta.extensionId = 'public'
    handlers.get('list_create')!(0, [current()], true)
    await nextTurn()
    assert.equal(calls, 0)
    handlers.get('list_create')!(0, [current()], false)
    await nextTurn()
    assert.equal(calls, 1)
    assert.equal(current().meta.autoSync, false)
    assert.equal(current().meta.songCount, 1)
    assert.ok(current().meta.syncTime > 0)
    current().meta.autoSync = true
    handlers.get('list_update')!([current()], false, false)
    await nextTurn()
    assert.equal(calls, 2)
    current().meta.autoSync = false
    await sync.syncAllList()
    assert.equal(calls, 2)
    fail = true
    const before = db.writes.length
    await assert.rejects(sync.syncList(current()), /source failed/)
    assert.equal(db.writes.length, before)
  } finally { await sync.close() }
})

test('a failed initial fetch leaves the online list available for a manual retry', async () => {
  const db = database('initial')
  const lists = createMusicList(db.service, async () => ({}), async () => {})
  const online = db.list()
  online.meta.autoSync = false
  const errors: unknown[] = []
  let calls = 0
  const sync = createOnlineListSync(lists, async () => {
    if (++calls === 1) throw new Error('source failed')
    return [music('recovered')]
  }, (error) => { errors.push(error) })
  try {
    await lists.musicListEvent.list_create(0, [online])
    await nextTurn()
    assert.equal(calls, 1)
    assert.match(String(errors[0]), /source failed/)
    assert.deepEqual(db.list(), online)
    assert.deepEqual(db.tracks(), [])
    assert.equal(db.writes.length, 0)
    await sync.syncList(online)
    assert.deepEqual(db.tracks().map((item) => item.id), ['recovered'])
    assert.equal(db.list().meta.autoSync, false)
  } finally {
    await sync.close()
    await lists.close()
  }
})

test('turning automatic sync off cancels queued and in-flight automatic results', async () => {
  const items = ['first', 'queued'].map(id => ({ id, type: 'online', meta: { autoSync: true } })) as AnyListen.List.OnlineListInfo[]
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const calls: string[] = []
  const commits: string[] = []
  let schedule!: (...args: any[]) => void
  const lists = {
    getAllUserLists: async () => ({ userList: structuredClone(items) }),
    commitOnlineListSync: async (snapshot: AnyListen.List.OnlineListInfo) => {
      assert.equal(snapshot.meta.autoSync, true)
      commits.push(snapshot.id)
      return { status: 'stale' }
    },
    musicListEvent: { on: (name: string, callback: (...args: any[]) => void) => { if (name === 'list_update') schedule = callback; return () => {} } },
  } as unknown as Parameters<typeof createOnlineListSync>[0]
  const sync = createOnlineListSync(lists, async item => { calls.push(item.id); await barrier; return [music('new')] }, () => {})
  try {
    schedule(items, false, false)
    await nextTurn()
    items.forEach(item => { item.meta.autoSync = false })
    release()
    await nextTurn()
    await sync.close()
    assert.deepEqual(calls, ['first'])
    assert.deepEqual(commits, ['first'])
  } finally { release(); await sync.close() }
})

for (const outcome of ['shared', 'retry', 'stale again'] as const) {
  test(`manual online sync with an in-flight automatic task: ${outcome}`, async () => {
    const db = database('current')
    db.list().meta.autoSync = true
    const lists = createMusicList(db.service, async () => ({}), async () => {})
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const sync = createOnlineListSync(lists, async () => {
      if (++calls === 1) await barrier
      else if (outcome === 'stale again') db.list().name = 'Edited twice'
      return [music(`result-${calls}`)]
    }, () => {})
    try {
      const background = sync.syncAllList()
      await nextTurn()
      assert.equal(calls, 1)
      if (outcome !== 'shared') db.list().meta.autoSync = false
      const manual = sync.syncList(db.list())
      const completed = outcome === 'stale again' ? assert.rejects(manual, /changed during sync/) : manual
      release()
      await Promise.all([background, completed])
      assert.equal(calls, outcome === 'shared' ? 1 : 2)
      assert.equal(db.writes.length, outcome === 'stale again' ? 0 : 1)
      assert.equal(db.list().meta.autoSync, outcome === 'shared')
      if (outcome !== 'stale again') assert.equal(db.tracks()[0].id, `result-${calls}`)
    } finally {
      release()
      await sync.close()
      await lists.close()
    }
  })
}
