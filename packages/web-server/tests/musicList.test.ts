import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'

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
    async updateUserLists(items: AnyListen.List.OnlineListInfo[]) {
      list = structuredClone(items[0])
    },
    async musicOverwrite(id: string, items: AnyListen.Music.MusicInfoOnline[]) {
      await nextTurn()
      tracks = structuredClone(items)
      writes.push([id, items])
    },
  } as unknown as DBSeriveTypes
  return { service, writes, covers: () => covers, tracks: () => tracks, list: () => list }
}

test('playlist instances isolate events, identical IDs, cover caches and deferred scroll saves', async () => {
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
    assert.equal(seenA.length, 2)
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
  const aSync = createOnlineListSync(
    a,
    async () => [music('a')],
    async (list) => {
      await aDb.service.updateUserLists([list])
    },
    (error) => errors.push(error)
  )
  const bSync = createOnlineListSync(
    b,
    async () => [music('b')],
    async (list) => {
      await bDb.service.updateUserLists([list])
    },
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
    assert.ok(bDb.list().meta.syncTime)
    assert.equal(aDb.writes.length, 1)
    assert.deepEqual(errors, [])
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
    async () => {},
    () => {}
  )
  const task = sync.syncList(db.list())
  assert.equal(sync.syncList(db.list()), task)
  await nextTurn()
  let closed = false
  const closing = sync.close().then(() => {
    closed = true
  })
  await nextTurn()
  assert.equal(closed, false)
  release()
  await Promise.all([task, closing])
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
