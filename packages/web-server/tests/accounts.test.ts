import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import Database from 'better-sqlite3'
import { createMessage2Call } from 'message2call'
import WebSocket from 'ws'

import { Accounts } from '../src/accounts/database'
import { createGateway } from '../src/accounts/gateway'
import { migrate } from '../src/accounts/migration'
import { snapshotExtensions, Publications } from '../src/accounts/publications'
import { Runtimes } from '../src/accounts/runtime'
import { signIdentity, verifyIdentity, LoginLimiter } from '../src/accounts/security'

const root = process.env.ACCOUNT_TEST_ROOT!
const password = 'Test-password-12345'
const workspace = () => mkdtemp(path.join(tmpdir(), 'any-listen-test-'))

test('signed identities bind user, lifetime and process generation; login limiter', () => {
  const identity = { userId: 'A', sessionId: 'S', role: 'user' as const, expires: Date.now() + 10000 }
  const token = signIdentity(identity, 'secret')
  assert.deepEqual(verifyIdentity(token, 'secret', 'A'), identity)
  assert.equal(verifyIdentity(token, 'secret', 'B'), null)
  assert.equal(verifyIdentity(token, 'new-generation', 'A'), null)
  assert.equal(verifyIdentity(signIdentity({ ...identity, expires: 1 }, 'secret'), 'secret', 'A'), null)
  const limiter = new LoginLimiter()
  for (let i = 0; i < 10; i++) limiter.check('127.0.0.1', 'Alice')
  assert.throws(() => limiter.check('another-ip', 'alice'), /Too many/)
})

test('account passwords, case-insensitive names, forced rotation and last admin', async () => {
  const dir = await workspace(),
    accounts = new Accounts(dir)
  try {
    const admin = await accounts.create('admin', password, 'admin', null)
    assert.equal(admin.mustChangePassword, 1)
    await assert.rejects(accounts.create('ADMIN', password, 'user', admin.id), /exists/)
    const { token } = await accounts.login('ADMIN', password, 'ip', 'browser')
    assert(accounts.session(token))
    assert(!JSON.stringify(accounts.sessions(admin.id)).includes(token))
    assert.throws(() => accounts.disable(admin.id, true, admin.id), /last administrator/)
    await accounts.password(admin.id, password + 'new', false, admin.id)
    assert.equal(accounts.session(token), null)
    await assert.rejects(accounts.password(admin.id, password, false, admin.id, admin.passwordHash), /Account changed/)
    const user = await accounts.create('alice', password, 'user', admin.id)
    const revoked = () => {
      throw new Error('Session expired')
    }
    await assert.rejects(accounts.create('revoked', password, 'user', admin.id, revoked), /Session expired/)
    assert.equal(accounts.find('revoked'), undefined)
    await assert.rejects(accounts.password(user.id, password + 'reset', true, admin.id, undefined, revoked), /Session expired/)
    assert.equal(accounts.get(user.id)!.passwordHash, user.passwordHash)
    const session = await accounts.login('alice', password, 'ip', 'browser')
    accounts.disable(user.id, true, admin.id)
    assert.equal(accounts.session(session.token), null)
  } finally {
    accounts.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent startup shares a process, idle reap and maintenance gate', async () => {
  const dir = await workspace(),
    accounts = new Accounts(dir)
  const runtimes = new Runtimes(dir, path.join(root, 'packages/web-server/tests/fixture.cjs'), 1)
  try {
    const user = await accounts.create('alice', password, 'user', null)
    const [one, two] = await Promise.all([runtimes.get(user), runtimes.get(user)])
    assert.equal(one.child.pid, two.child.pid)
    await delay(5)
    await runtimes.reap()
    assert.equal(runtimes.entries.size, 0)
    await runtimes.pauseStarts()
    let started = false
    const pending = runtimes.get(user).then(() => {
      started = true
    })
    await delay(20)
    assert.equal(started, false)
    runtimes.resumeStarts()
    await pending
    assert.equal(started, true)
  } finally {
    runtimes.resumeStarts()
    await runtimes.close()
    accounts.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('revoking a session blocks an administrator request still uploading its body', async () => {
  const dir = await workspace(),
    accounts = new Accounts(dir)
  const runtimes = new Runtimes(dir, path.join(root, 'packages/web-server/tests/fixture.cjs'))
  const gateway = createGateway(accounts, runtimes, dir)
  try {
    const admin = await accounts.create('admin', password, 'admin', null)
    await accounts.password(admin.id, password, false, admin.id)
    const login = await accounts.login('admin', password, 'ip', 'browser')
    gateway.server.listen(0, '127.0.0.1')
    await once(gateway.server, 'listening')
    const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`
    let received!: () => void
    const bodyPending = new Promise<void>((resolve) => {
      received = resolve
    })
    gateway.server.once('request', received)
    const request = http.request(origin + '/account-api/users', {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: `anylisten_session=${login.token}`,
        'Content-Type': 'application/json',
      },
    })
    const response = once(request, 'response')
    request.write('{"username":"blocked",')
    await bodyPending
    accounts.revoke(login.session.id, admin.id)
    request.end(`"password":"${password}","role":"user"}`)
    const [result] = await response
    result.resume()
    assert.equal(result.statusCode, 401)
    assert.equal(accounts.find('blocked'), undefined)
  } finally {
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration preserves database and device data, does not import old sessions, is idempotent', async () => {
  const dir = await workspace(),
    destination = path.join(dir, 'new'),
    source = path.join(dir, 'old')
  const accounts = new Accounts(destination)
  try {
    await mkdir(path.join(source, 'app'), { recursive: true })
    const old = new Database(path.join(source, 'app', 'data.db'))
    old.exec("CREATE TABLE lists(id TEXT); INSERT INTO lists VALUES('same-id')")
    old.close()
    await writeFile(path.join(source, 'app', 'data.json'), JSON.stringify({ machineId: 'unchanged', filePath: '/old/music.mp3' }))
    await writeFile(path.join(source, 'tokens.json'), 'old token')
    const admin = await accounts.create('admin', password, 'admin', null)
    await migrate(accounts, destination, admin.id, source)
    await migrate(accounts, destination, admin.id, source)
    const target = path.join(destination, 'users', admin.id)
    assert.equal(JSON.parse(await readFile(path.join(target, 'app', 'data.json'), 'utf8')).machineId, 'unchanged')
    assert.equal(JSON.parse(await readFile(path.join(target, 'migration-report.json'), 'utf8')).warnings.length, 1)
    await assert.rejects(readFile(path.join(target, 'tokens.json')))
    assert.equal(await readFile(path.join(source, 'tokens.json'), 'utf8'), 'old token')
  } finally {
    accounts.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('publication snapshots contain only managed data and validate script references', async () => {
  const dir = await workspace(),
    source = path.join(dir, 'draft'),
    target = path.join(dir, 'release')
  try {
    const scriptId = 'a'.repeat(32)
    for (const id of ['online-metadata', 'lx-api-source-loader']) {
      await mkdir(path.join(source, 'ext', id), { recursive: true })
      await writeFile(path.join(source, 'ext', id, 'manifest.json'), JSON.stringify({ id }))
      await mkdir(path.join(source, 'datas', id, 'storage', 'scripts'), { recursive: true })
      await writeFile(path.join(source, 'datas', id, 'private-runtime.json'), 'not shared')
      await writeFile(
        path.join(source, 'datas', id, 'configuration.json'),
        JSON.stringify(
          id === 'lx-api-source-loader' ? { enabledScripts: [scriptId], importedScriptSources: [{ id: scriptId }] } : {}
        )
      )
    }
    await writeFile(
      path.join(source, 'extensions.json'),
      JSON.stringify(['online-metadata', 'lx-api-source-loader'].map((id) => ({ id, enabled: true })))
    )
    await assert.rejects(snapshotExtensions(source, target))
    await writeFile(path.join(source, 'datas/lx-api-source-loader/storage/scripts', scriptId), 'script')
    await snapshotExtensions(source, target)
    await assert.rejects(readFile(path.join(target, 'datas/online-metadata/private-runtime.json')))
    assert.equal(await readFile(path.join(target, 'datas/lx-api-source-loader/storage/scripts', scriptId), 'utf8'), 'script')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('real gateway: account isolation, backup, RPC authorization, websocket revocation, Range', { timeout: 120000 }, async () => {
  const dir = await workspace(),
    accounts = new Accounts(dir)
  const runtimes = new Runtimes(dir, path.join(root, 'build/server/index.js'))
  const gateway = createGateway(accounts, runtimes, path.join(root, 'build/public'))
  const sockets: WebSocket[] = []
  let streamClosed = false
  const media = http.createServer((req, res) => {
    assert.equal(req.headers['x-anylisten-identity'], undefined)
    assert.equal(req.headers.cookie, undefined)
    if (req.url === '/continuous.mp3') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
      const timer = setInterval(() => res.write(Buffer.alloc(1024)), 20)
      res.once('close', () => {
        clearInterval(timer)
        streamClosed = true
      })
    } else if (req.headers.range === 'bytes=2-5') {
      res.writeHead(206, { 'Content-Range': 'bytes 2-5/10', 'Content-Length': '4', 'Accept-Ranges': 'bytes' })
      res.end('2345')
    } else {
      res.writeHead(200, { 'Content-Length': '10' })
      res.end('0123456789')
    }
  })
  try {
    gateway.server.listen(0, '127.0.0.1')
    await once(gateway.server, 'listening')
    const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`
    const api = async (url: string, cookie = '', method = 'GET', data?: unknown) =>
      fetch(origin + url, {
        method,
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      })
    const users = []
    for (const name of ['admin', 'alice', 'bobby']) {
      const user = await accounts.create(name, password, name === 'admin' ? 'admin' : 'user', null)
      await accounts.password(user.id, password, false, user.id)
      const response = await api('/account-api/login', '', 'POST', { username: name, password })
      assert.equal(response.status, 200)
      users.push({ user, cookie: response.headers.get('set-cookie')!.split(';')[0] })
    }
    const [admin, alice, bob] = users
    const rpc = async (login: typeof alice, events: unknown[]) => {
      const ws = new WebSocket(origin.replace('http:', 'ws:') + `/u/${login.user.id}/api/ipc?t=main`, {
        headers: { Cookie: login.cookie, Origin: origin },
      })
      sockets.push(ws)
      const client = createMessage2Call<any>({
        exposeObj: {
          listAction: (event: unknown) => {
            events.push(event)
          },
          playListAction: (event: unknown) => {
            events.push(event)
          },
          playerAction: (event: unknown) => {
            events.push(event)
          },
          playHistoryListAction: (event: unknown) => {
            events.push(event)
          },
        },
        timeout: 5000,
        sendMessage: (data: unknown) => ws.send(JSON.stringify(data)),
      })
      ws.on('message', (raw) => {
        if (raw.toString() !== 'ping') client.message(JSON.parse(raw.toString()))
      })
      await once(ws, 'open')
      await client.remote.inited().catch((e: Error) => {
        throw new Error(`inited ${login.user.username}: ${e.message}`)
      })
      return client
    }
    assert.equal((await api('/account-api/users', alice.cookie)).status, 403)
    assert.equal((await api(`/u/${bob.user.id}/api/account-backup`, alice.cookie)).status, 403)
    assert.equal((await api('/account-api/login', '', 'POST', null)).status, 400)
    assert.equal(
      (
        await fetch(origin + '/account-api/users', {
          method: 'POST',
          headers: { Cookie: admin.cookie, Origin: 'https://other.example', 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      403
    )
    const temporary = await accounts.create('temporary', password, 'user', admin.user.id)
    const tempLogin = await api('/account-api/login', '', 'POST', { username: temporary.username, password })
    const tempCookie = tempLogin.headers.get('set-cookie')!.split(';')[0]
    assert.equal((await api(`/u/${temporary.id}/api/account-backup`, tempCookie)).status, 403)
    assert.equal(
      (await api('/account-api/password', tempCookie, 'POST', { currentPassword: password, password: password + '-new' })).status,
      200
    )
    assert.equal((await api('/account-api/me', tempCookie)).status, 401)
    const prefix = `/u/${alice.user.id}/api/account-backup`
    const backupResponse = await api(prefix, alice.cookie)
    assert.equal(backupResponse.status, 200, await backupResponse.clone().text())
    const backup = await backupResponse.json()
    backup.songlist.defaultList.name = 'Alice private list'
    assert.equal((await api(prefix, alice.cookie, 'POST', backup)).status, 200)
    const bobBackup = await (await api(`/u/${bob.user.id}/api/account-backup`, bob.cookie)).json()
    assert.notEqual(bobBackup.songlist.defaultList.name, 'Alice private list')
    assert.equal((await (await api(prefix, alice.cookie)).json()).songlist.defaultList.name, 'Alice private list')
    const aEvents: unknown[] = [],
      a2Events: unknown[] = [],
      bEvents: unknown[] = []
    const aRpc = await rpc(alice, aEvents),
      a2Rpc = await rpc(alice, a2Events),
      bRpc = await rpc(bob, bEvents)
    for (const method of [
      'executeCommand',
      'getAllExtensionSettings',
      'fileSystemAction',
      'importData',
      'exportData',
      'downloadUpdate',
    ])
      await assert.rejects(aRpc.remote[method](), /Forbidden/)
    await assert.rejects(
      aRpc.remote.listAction({
        action: 'list_create',
        data: { position: 0, listInfos: [{ type: 'local', meta: { path: '/' } }] },
      }),
      /cannot be imported/
    )
    backup.songlist.defaultList.name = 'Synced same account'
    assert.equal((await api(prefix, alice.cookie, 'POST', backup)).status, 200)
    await delay(100)
    assert(aEvents.length > 0)
    assert(a2Events.length > 0)
    assert.equal(bEvents.length, 0)
    assert.equal((await a2Rpc.remote.getAllUserLists()).defaultList.name, 'Synced same account')
    assert.notEqual((await bRpc.remote.getAllUserLists()).defaultList.name, 'Synced same account')
    const song = (name: string) => ({
      id: 'same-song-id',
      name,
      singer: 'Test',
      interval: '00:10',
      isLocal: false,
      meta: {
        musicId: 'same-song-id',
        source: 'test',
        albumName: 'Test',
        createTime: 0,
        updateTime: 0,
        posTime: 0,
        qualitys: {},
      },
    })
    await Promise.all(
      [aRpc.remote, bRpc.remote].map((remote, index) =>
        remote.listAction({
          action: 'list_music_add',
          data: { id: 'default', musicInfos: [song(index ? 'Bob song' : 'Alice song')], addMusicLocationType: 'bottom' },
        })
      )
    )
    assert.equal((await a2Rpc.remote.getListMusics('default'))[0].name, 'Alice song')
    assert.equal((await bRpc.remote.getListMusics('default'))[0].name, 'Bob song')
    await aRpc.remote.listAction({
      action: 'list_music_add',
      data: { id: 'love', musicInfos: [song('Alice song')], addMusicLocationType: 'bottom' },
    })
    assert.equal((await a2Rpc.remote.getListMusics('love')).length, 1)
    assert.equal((await bRpc.remote.getListMusics('love')).length, 0)
    await aRpc.remote.playListAction({
      action: 'set',
      data: {
        listId: 'default',
        source: 'local',
        list: [
          {
            itemId: 'private-queue',
            musicInfo: song('Alice song'),
            listId: 'default',
            source: 'local',
            played: false,
            playLater: false,
          },
        ],
      },
    })
    assert.equal((await a2Rpc.remote.getPlayInfo()).list[0].itemId, 'private-queue')
    assert.equal((await bRpc.remote.getPlayInfo()).list.length, 0)
    await aRpc.remote.saveSearchHistoryList(['Alice private search'])
    assert.deepEqual(await a2Rpc.remote.getSearchHistoryList(), ['Alice private search'])
    assert.deepEqual((await bRpc.remote.getSearchHistoryList()) ?? [], [])
    await aRpc.remote.listAction({ action: 'list_music_remove', data: { listId: 'default', ids: ['same-song-id'] } })
    assert.equal((await a2Rpc.remote.getListMusics('default')).length, 0)
    assert.equal((await bRpc.remote.getListMusics('default')).length, 1)
    media.listen(0, '127.0.0.1')
    await once(media, 'listening')
    const mediaUrl = `http://127.0.0.1:${(media.address() as { port: number }).port}/test.mp3`
    const proxyPath = `/u/${alice.user.id}/api/p_url/${encodeURIComponent(mediaUrl)}`
    const range = await fetch(origin + proxyPath, { headers: { Cookie: alice.cookie, Range: 'bytes=2-5' } })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), '2345')
    assert.match(range.headers.get('cache-control')!, /no-store/)
    assert.equal((await api(proxyPath, bob.cookie)).status, 403)
    const controller = new AbortController()
    const stream = await fetch(
      origin + `/u/${alice.user.id}/api/p_url/${encodeURIComponent(mediaUrl.replace('test.mp3', 'continuous.mp3'))}`,
      {
        headers: { Cookie: alice.cookie },
        signal: controller.signal,
      }
    )
    await stream.body!.getReader().read()
    controller.abort()
    for (let attempt = 0; !streamClosed && attempt < 100; attempt++) await delay(20)
    assert(streamClosed, 'Cancelling a client stream must close its music origin connection')
    const runtime = runtimes.entries.get(alice.user.id)!
    assert.equal((await fetch(`http://127.0.0.1:${runtime.port}/api/account-backup`)).status, 401)
    assert.equal(
      (await fetch(`http://127.0.0.1:${runtime.port}/api/account-backup`, { headers: { 'x-anylisten-identity': 'forged' } }))
        .status,
      401
    )
    const socket = new WebSocket(origin.replace('http:', 'ws:') + `/u/${alice.user.id}/api/ipc?t=main`, {
      headers: { Cookie: alice.cookie, Origin: origin },
    })
    sockets.push(socket)
    await once(socket, 'open')
    const bobSession = await (await api('/account-api/me', bob.cookie)).json()
    assert.equal((await api(`/account-api/sessions/${bobSession.sessionId}`, alice.cookie, 'DELETE')).status, 200)
    assert.equal((await api('/account-api/me', bob.cookie)).status, 200)
    const oldBobClosed = once(sockets[2], 'close')
    const switched = await api('/account-api/login', bob.cookie, 'POST', { username: 'admin', password })
    assert.equal(switched.status, 200)
    await oldBobClosed
    assert.equal((await api('/account-api/me', bob.cookie)).status, 401)
    const closed = once(socket, 'close')
    assert.equal(
      (await api(`/account-api/users/${alice.user.id}/password`, admin.cookie, 'POST', { password: password + 'reset' })).status,
      200
    )
    await closed
    assert.equal((await api(prefix, alice.cookie)).status, 401)
    const adminStream = await rpc(admin, [])
    const adminSocket = sockets.at(-1)!
    const restarted = once(adminSocket, 'close')
    await runtimes.stop(admin.user.id)
    assert.equal((await restarted)[0], 1012)
    adminStream.destroy()
    const bobLogin = await api('/account-api/login', '', 'POST', { username: 'bobby', password })
    const newBobCookie = bobLogin.headers.get('set-cookie')!.split(';')[0]
    assert.equal((await api(`/account-api/users/${bob.user.id}/disabled`, admin.cookie, 'POST', { disabled: true })).status, 200)
    assert.equal((await api('/account-api/me', newBobCookie)).status, 401)
  } finally {
    media.close()
    for (const socket of sockets) socket.terminate()
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('publication rollback restores switched accounts and releases the maintenance gate', { timeout: 120000 }, async () => {
  const dir = await workspace(),
    accounts = new Accounts(dir)
  const runtimes = new Runtimes(dir, path.join(root, 'packages/web-server/tests/fixture.cjs'))
  const publications = new Publications(accounts, runtimes)
  runtimes.prepare = (user) => publications.apply(user)
  try {
    const admin = await accounts.create('admin', password, 'admin', null)
    const alice = await accounts.create('alice', password, 'user', admin.id)
    const bob = await accounts.create('bobby', password, 'user', admin.id)
    const draft = path.join(dir, 'users', admin.id, 'app/extension')
    await mkdir(draft, { recursive: true })
    await writeFile(
      path.join(draft, 'extensions.json'),
      JSON.stringify(['online-metadata', 'lx-api-source-loader'].map((id) => ({ id, enabled: false })))
    )
    for (const id of ['online-metadata', 'lx-api-source-loader']) {
      await mkdir(path.join(draft, 'ext', id), { recursive: true })
      await writeFile(path.join(draft, 'ext', id, 'manifest.json'), JSON.stringify({ id }))
    }
    await runtimes.get(alice)
    await runtimes.get(bob)
    await publications.publish(admin)
    const previous = publications.status().version!
    const applied = (id: string) => readFile(path.join(dir, 'users', id, 'app/extension/managed-version'), 'utf8')
    assert.equal(await applied(alice.id), previous)
    let failOnce = true
    runtimes.prepare = async (user) => {
      await publications.apply(user)
      if (user.id === bob.id && failOnce) {
        failOnce = false
        throw new Error('Injected rollout failure')
      }
    }
    await assert.rejects(publications.publish(admin), /Publication failed/)
    assert.equal(publications.status().version, previous)
    assert.equal(await applied(alice.id), previous)
    assert.equal(await applied(bob.id), previous)
    assert.equal(publications.status().running, false)
    assert((await runtimes.get(alice)).port)
    await publications.publish(admin)
    assert.notEqual(publications.status().version, previous)
  } finally {
    await runtimes.close()
    accounts.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test(
  'real extension host validates publication, serves search and source URL, preserves private runtime files',
  { timeout: 120000 },
  async () => {
    const dir = await workspace(),
      accounts = new Accounts(dir)
    const runtimes = new Runtimes(dir, path.join(root, 'build/server/index.js'))
    const publications = new Publications(accounts, runtimes)
    runtimes.prepare = (user) => publications.apply(user)
    const sockets: WebSocket[] = []
    try {
      const admin = await accounts.create('admin', password, 'admin', null)
      const user = await accounts.create('alice', password, 'user', admin.id)
      const draft = path.join(dir, 'users', admin.id, 'app/extension')
      const song = {
        id: 'test-song',
        name: 'Test music',
        singer: 'Test artist',
        interval: '00:10',
        isLocal: false,
        meta: {
          musicId: 'test-song',
          source: 'test',
          albumName: 'Test',
          createTime: 0,
          updateTime: 0,
          posTime: 0,
          qualitys: { '128k': { sizeStr: null } },
        },
      }
      const scriptId = 'b'.repeat(32)
      for (const id of ['online-metadata', 'lx-api-source-loader']) {
        await mkdir(path.join(draft, 'ext', id), { recursive: true })
        await mkdir(path.join(draft, 'datas', id, 'storage/scripts'), { recursive: true })
        await writeFile(
          path.join(draft, 'ext', id, 'manifest.json'),
          JSON.stringify({
            id,
            name: id,
            version: '1.0.0',
            main: 'index.js',
            contributes: {
              resource: [{ id: 'test', name: 'Test', resource: id === 'online-metadata' ? ['musicSearch'] : ['musicUrl'] }],
            },
          })
        )
        await writeFile(
          path.join(draft, 'ext', id, 'index.js'),
          id === 'online-metadata'
            ? `require('any-listen').registerResourceAction({musicSearch: async () => ({list:[${JSON.stringify(song)}],total:1,page:1,limit:30})})`
            : `const api = require('any-listen'); api.logcat.info('[Test script]Init successfully: test'); api.registerResourceAction({musicUrl: async () => ({url:'https://example.com/test.mp3',quality:'128k'})})`
        )
        await writeFile(
          path.join(draft, 'datas', id, 'configuration.json'),
          JSON.stringify(
            id === 'lx-api-source-loader'
              ? { enabledScripts: [scriptId], importedScriptSources: [{ id: scriptId, name: 'Test script' }] }
              : {}
          )
        )
      }
      await writeFile(path.join(draft, 'datas/lx-api-source-loader/storage/scripts', scriptId), 'controlled source fixture')
      await writeFile(
        path.join(draft, 'extensions.json'),
        JSON.stringify(['online-metadata', 'lx-api-source-loader'].map((id) => ({ id, enabled: true })))
      )
      await publications.publish(admin)
      const runtime = await runtimes.get(user)
      const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}/api/ipc/socket?t=main`, {
        headers: {
          'x-anylisten-identity': signIdentity(
            { userId: user.id, sessionId: 'test-session', role: 'user', expires: Date.now() + 60000 },
            runtime.secret
          ),
        },
      })
      sockets.push(ws)
      const rpc = createMessage2Call<any>({
        exposeObj: {},
        timeout: 5000,
        sendMessage: (data: unknown) => ws.send(JSON.stringify(data)),
      })
      ws.on('message', (raw) => {
        if (raw.toString() !== 'ping') rpc.message(JSON.parse(raw.toString()))
      })
      await once(ws, 'open')
      const results = await rpc.remote.musicSearch({ extensionId: 'online-metadata', source: 'test', name: 'Test', page: 1 })
      assert.equal(results.list[0].name, 'Test music')
      const extensions = await rpc.remote.getExtensionList()
      assert(extensions.some((item: any) => item.id === 'lx-api-source-loader' && item.loaded))
      assert(extensions.every((item: any) => !item.directory && !item.dataDirectory && !item.contributes?.settings))
      const url = await rpc.remote.getMusicUrl({ musicInfo: song, quality: '128k', isRefresh: true })
      assert.equal(url.url, 'https://example.com/test.mp3')
      const privateFile = path.join(dir, 'users', user.id, 'app/extension/datas/online-metadata/storage/private.json')
      await mkdir(path.dirname(privateFile), { recursive: true })
      await writeFile(privateFile, 'private')
      ws.terminate()
      await publications.publish(admin)
      assert.equal(await readFile(privateFile, 'utf8'), 'private')
    } finally {
      for (const socket of sockets) socket.terminate()
      await runtimes.close()
      accounts.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
)
