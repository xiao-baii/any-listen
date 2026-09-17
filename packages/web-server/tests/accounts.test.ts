import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import Database from 'better-sqlite3'
import { createMessage2Call } from 'message2call'
import WebSocket from 'ws'
import defaultSetting from '../../shared/common/defaultSetting'

import { interceptors } from '../../shared/nodejs/node_modules/undici'
import { isPublicAddress, publicNetworkAgent } from '../../shared/nodejs/publicNetwork'
import { initializeAdmin } from '../src/accounts/bootstrap'
import { Accounts } from '../src/accounts/database'
import { createGateway } from '../src/accounts/gateway'
import { migrate } from '../src/accounts/migration'
import { snapshotExtensions, Publications } from '../src/accounts/publications'
import { Runtimes } from '../src/accounts/runtime'
import { signIdentity, verifyIdentity, LoginLimiter } from '../src/accounts/security'

const root = process.env.ACCOUNT_TEST_ROOT!
const password = 'Test-password-12345'
const workspace = () => mkdtemp(path.join(tmpdir(), 'any-listen-test-'))

test('startup initializes an empty database and preserves existing accounts across restarts', async () => {
  const dir = await workspace()
  let accounts = new Accounts(dir)
  try {
    for (const env of [
      {},
      { ADMIN_USERNAME: 'admin' },
      { ADMIN_PASSWORD: password },
      { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '' },
      { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a'.repeat(129) },
      { ADMIN_USERNAME: '!', ADMIN_PASSWORD: password },
      { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password, ADMIN_PASSWORD_FILE: 'unused' },
    ]) {
      await assert.rejects(initializeAdmin(accounts, env))
      assert.equal(accounts.list().length, 0)
      assert.equal(env.ADMIN_PASSWORD, undefined)
    }
    const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a' }
    await initializeAdmin(accounts, env)
    assert.equal(env.ADMIN_PASSWORD, undefined)
    const admin = accounts.find('admin')!
    assert.equal(admin.role, 'admin')
    assert.notEqual(admin.passwordHash, password)
    await accounts.login('admin', 'a', 'ip', 'browser')
    await accounts.password(admin.id, password + '-changed', admin.id)
    const changedHash = accounts.get(admin.id)!.passwordHash
    accounts.close()
    accounts = new Accounts(dir)
    await initializeAdmin(accounts, {})
    const staleEnv = { ADMIN_USERNAME: 'replacement', ADMIN_PASSWORD: password, ADMIN_PASSWORD_FILE: 'missing' }
    await initializeAdmin(accounts, staleEnv)
    assert.equal(staleEnv.ADMIN_PASSWORD, undefined)
    assert.equal(staleEnv.ADMIN_PASSWORD_FILE, undefined)
    assert.equal(accounts.list().length, 1)
    assert.equal(accounts.get(admin.id)!.passwordHash, changedHash)
    await assert.rejects(accounts.login('admin', password, 'ip', 'browser'), /Invalid/)
    await accounts.login('admin', password + '-changed', 'ip', 'browser')
  } finally {
    accounts.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('only deployment initialization can create the single administrator, including concurrent requests', async () => {
  const dir = await workspace(), accounts = new Accounts(dir)
  try {
    await assert.rejects(accounts.create('blocked', password, 'admin', 'actor'), /deployment initialization/)
    assert.equal(accounts.list().length, 0)
    const attempts = await Promise.allSettled([
      accounts.create('first', password, 'admin', null),
      accounts.create('second', password, 'admin', null),
    ])
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1)
    const admin = accounts.list()[0]
    assert.equal(admin.role, 'admin')
    await assert.rejects(accounts.create('third', password, 'admin', null), /already exists/)
    const user = await accounts.create('ordinary', password, 'user', admin.id)
    assert.throws(() => accounts.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id), /UNIQUE/)
    assert.throws(() => accounts.disable(admin.id, true, admin.id), /Cannot disable the administrator/)
  } finally {
    accounts.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('startup supports a password file and leaves the database empty on read failure', async () => {
  const dir = await workspace(),
    accounts = new Accounts(dir)
  const passwordFile = path.join(dir, 'password.txt')
  try {
    await assert.rejects(initializeAdmin(accounts, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_FILE: passwordFile }))
    assert.equal(accounts.list().length, 0)
    await writeFile(passwordFile, password + '\n')
    await initializeAdmin(accounts, { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_FILE: passwordFile })
    await accounts.login('admin', password, 'ip', 'browser')
  } finally {
    accounts.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('outbound media blocks private IPs, DNS and redirects, with exact-origin exceptions', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2002:7f00:1::',
  ])
    assert.equal(isPublicAddress(address), false, address)
  for (const address of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true)
  let reached = 0
  const target = http.createServer((_req, res) => {
    reached++
    res.end('private')
  })
  target.listen(0, '127.0.0.1')
  await once(target, 'listening')
  const targetOrigin = `http://127.0.0.1:${(target.address() as { port: number }).port}`
  const redirect = http.createServer((_req, res) => {
    res.writeHead(302, { Location: targetOrigin })
    res.end()
  })
  redirect.listen(0, '127.0.0.1')
  await once(redirect, 'listening')
  const redirectOrigin = `http://127.0.0.1:${(redirect.address() as { port: number }).port}`
  const agent = publicNetworkAgent([redirectOrigin])
  try {
    await assert.rejects(agent.request({ origin: targetOrigin, path: '/', method: 'GET' }), /Private network/)
    await assert.rejects(
      agent.request({ origin: targetOrigin.replace('127.0.0.1', 'localhost'), path: '/', method: 'GET' }),
      /Private network/
    )
    await assert.rejects(
      agent.compose(interceptors.redirect({ maxRedirections: 3 })).request({ origin: redirectOrigin, path: '/', method: 'GET' }),
      /Private network/
    )
    assert.equal(reached, 0)
  } finally {
    await agent.close()
    target.close()
    redirect.close()
  }
})

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

test('account passwords, case-insensitive names, session revocation and administrator protection', async () => {
  const dir = await workspace(),
    accounts = new Accounts(dir)
  try {
    const admin = await accounts.create('admin', password, 'admin', null)
    await assert.rejects(accounts.create('ADMIN', password, 'user', admin.id), /exists/)
    const { token } = await accounts.login('ADMIN', password, 'ip', 'browser')
    assert(accounts.session(token))
    assert(!JSON.stringify(accounts.sessions(admin.id)).includes(token))
    assert.throws(() => accounts.disable(admin.id, true, admin.id), /Cannot disable the administrator/)
    await accounts.password(admin.id, password + 'new', admin.id)
    assert.equal(accounts.session(token), null)
    await assert.rejects(accounts.password(admin.id, password, admin.id, admin.passwordHash), /Account changed/)
    const user = await accounts.create('alice', password, 'user', admin.id)
    const revoked = () => {
      throw new Error('Session expired')
    }
    await assert.rejects(accounts.create('revoked', password, 'user', admin.id, revoked), /Session expired/)
    assert.equal(accounts.find('revoked'), undefined)
    await assert.rejects(accounts.password(user.id, password + 'reset', admin.id, undefined, revoked), /Session expired/)
    assert.equal(accounts.get(user.id)!.passwordHash, user.passwordHash)
    const session = await accounts.login('alice', password, 'ip', 'browser')
    accounts.disable(user.id, true, admin.id)
    assert.equal(accounts.session(session.token), null)
  } finally {
    accounts.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('password creation and rotation accept 1 to 128 characters and reject empty or oversized values', async () => {
  const dir = await workspace(),
    accounts = new Accounts(dir)
  try {
    const admin = await accounts.create('admin', 'a', 'admin', null)
    const user = await accounts.create('alice', 'b', 'user', admin.id)
    for (const invalid of ['', 'a'.repeat(129)]) {
      await assert.rejects(accounts.create('invalid', invalid, 'user', admin.id), /1 to 128/)
      await assert.rejects(accounts.password(user.id, invalid, user.id), /1 to 128/)
    }
    for (const [value, adminReset] of [
      ['c', true],
      ['d', false],
      ['a'.repeat(128), false],
    ] as const) {
      await accounts.password(user.id, value, adminReset ? admin.id : user.id)
      const result = await accounts.login('alice', value, 'ip', 'browser')
      assert.equal(result.user.id, user.id)
    }
  } finally {
    accounts.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent startup shares a process, idle reap and maintenance gate', async () => {
  const dir = await workspace(),
    accounts = new Accounts(dir)
  const runtimes = new Runtimes(dir, path.join(root, 'build/server/index.js'), 1)
  try {
    const user = await accounts.create('alice', password, 'user', null)
    const [one, two] = await Promise.all([runtimes.get(user), runtimes.get(user)])
    assert.equal(one, two)
    assert.equal(one.child, undefined)
    assert.ok(one.context)
    assert.equal(path.relative(dir, runtimes.temporaryRoot).startsWith('..'), true)
    assert((await stat(path.join(runtimes.temporaryRoot, 'users', user.id, 'cache/proxy'))).isDirectory())
    assert((await stat(path.join(runtimes.temporaryRoot, 'users', user.id, 'temp'))).isDirectory())
    for (const name of ['cache', 'temp'])
      await assert.rejects(stat(path.join(dir, 'users', user.id, name)), { code: 'ENOENT' })
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
    await runtimes.close()
    await assert.rejects(stat(runtimes.temporaryRoot), { code: 'ENOENT' })
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
    request.end(`"password":"${password}"}`)
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
      const response = await api('/account-api/login', '', 'POST', { username: name, password })
      assert.equal(response.status, 200)
      users.push({ user, cookie: response.headers.get('set-cookie')!.split(';')[0] })
    }
    const [admin, alice, bob] = users
    assert.equal((await api('/account-api/maintenance')).status, 401)
    const maintenance = await api('/account-api/maintenance', alice.cookie)
    assert.equal(maintenance.status, 200)
    assert.deepEqual(await maintenance.json(), { running: false })
    const deniedAdmin = await api('/account-api/users', admin.cookie, 'POST', { username: 'extra-admin', password, role: 'admin' })
    assert.equal(deniedAdmin.status, 403)
    assert.equal(accounts.find('extra-admin'), undefined)
    const created = await api('/account-api/users', admin.cookie, 'POST', { username: 'created-user', password })
    assert.equal(created.status, 201)
    assert.equal((await created.json()).user.role, 'user')
    assert.equal((await api('/account-api/users', admin.cookie, 'POST', { username: 'explicit-role', password, role: 'user' })).status, 400)
    assert.equal((await api('/account-api/users', alice.cookie, 'POST', { username: 'forbidden', password })).status, 403)
    for (const login of [admin, alice]) {
      const appDir = path.join(dir, 'users', login.user.id, 'app')
      await mkdir(appDir, { recursive: true })
      await writeFile(
        path.join(appDir, 'config.json'),
        JSON.stringify({ setting: { version: '1.0.2', 'network.proxyAllResources': true } })
      )
    }
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
          themeChanged: () => {},
          themeListChanged: () => {},
          hotKeyConfigUpdated: () => {},
          dislikeAction: () => {},
          settingChanged: () => {},
          extensionEvent: (event: unknown) => { events.push(event) },
        },
        timeout: 5000,
        sendMessage: (data: unknown) => ws.send(JSON.stringify(data)),
      })
      ws.on('message', (raw) => {
        if (raw.toString() !== 'ping') client.message(JSON.parse(raw.toString()))
      })
      await once(ws, 'open').catch(error => { throw new Error(`Connect ${login.user.username}: ${error.message}`) })
      await client.remote.inited().catch((e: Error) => {
        throw new Error(`inited ${login.user.username}: ${e.message}`)
      })
      return client
    }
    assert.equal((await api('/account-api/users', alice.cookie)).status, 403)
    assert.equal((await api('/account-api/settings', alice.cookie)).status, 403)
    assert.equal((await api('/account-api/settings', alice.cookie, 'POST', { proxyAllResources: true })).status, 403)
    assert.deepEqual(await (await api('/account-api/settings', admin.cookie)).json(), { proxyAllResources: false, onlineResourceEnabled: false, ghMirrorHosts: defaultSetting['extension.ghMirrorHosts'] })
    assert.equal((await api('/account-api/settings', admin.cookie, 'POST', { proxyAllResources: 'true' })).status, 400)
    assert.equal((await api('/account-api/settings', admin.cookie, 'POST', { proxyAllResources: false, onlineResourceEnabled: 'true' })).status, 400)
    for (const ghMirrorHosts of [null, 'ftp://mirror.example', 'https://user:secret@mirror.example', 'invalid', 'https://mirror.example?q=1', 'x'.repeat(8193)]) {
      assert.equal((await api('/account-api/settings', admin.cookie, 'POST', { proxyAllResources: false, onlineResourceEnabled: false, ghMirrorHosts })).status, 400)
    }
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
    assert.equal((await api(`/u/${temporary.id}/api/account-backup`, tempCookie)).status, 200)
    assert.equal((await api(`/account-api/users/${temporary.id}/password`, admin.cookie, 'POST', { password: password + '-reset' })).status, 200)
    assert.equal((await api('/account-api/me', tempCookie)).status, 401)
    const resetLogin = await api('/account-api/login', '', 'POST', { username: temporary.username, password: password + '-reset' })
    assert.equal(resetLogin.status, 200)
    assert.equal((await resetLogin.json()).user.id, temporary.id)
    const resetCookie = resetLogin.headers.get('set-cookie')!.split(';')[0]
    assert.equal((await api(`/u/${temporary.id}/api/account-backup`, resetCookie)).status, 200)
    assert.equal(
      (await api('/account-api/password', resetCookie, 'POST', { currentPassword: password + '-reset', password: password + '-new' })).status,
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
    const adminEvents: any[] = []
    const adminRpc = await rpc(admin, adminEvents)
    const logEvent = { value: { action: 'logOutput', data: { id: 'lx-api-source-loader', name: 'Loader',
      type: 'info', timestamp: Date.now(), message: 'Administrator source log' } }, assets: {} }
    await (await runtimes.get(admin.user)).context.sourceEvent(logEvent)
    await (await runtimes.get(alice.user)).context.sourceEvent(logEvent)
    for (let attempt = 0; attempt < 50 && !adminEvents.some(event => event.action === 'logOutput'); attempt++) await delay(20)
    assert(adminEvents.some(event => event.action === 'logOutput'))
    assert(!aEvents.some((event: any) => event.action === 'logOutput'), 'Source logs are not broadcast to ordinary accounts')
    assert.equal((await runtimes.get(admin.user)).child, undefined)
    assert.equal(runtimes.status().topology, 'single-process-shared-workers')
    assert.equal(new Set(runtimes.status().active.map(runtime => runtime.process)).size, 1)
    assert.equal((await api('/account-api/source-script', alice.cookie, 'POST', {})).status, 403)
    assert.equal((await api('/account-api/source-package', alice.cookie, 'POST', {})).status, 403)
    assert.equal((await api('/account-api/source-remote', alice.cookie, 'POST', {})).status, 403)
    assert.equal((await api('/account-api/source-scripts', alice.cookie)).status, 403)
    assert.equal((await api('/account-api/source-scripts', '')).status, 401)
    for (const client of [adminRpc, aRpc, bRpc]) {
      await client.remote.setSetting({ 'sync.webdav.enable': true })
      assert.equal((await client.remote.getSetting())['sync.webdav.enable'], false)
      assert.equal((await client.remote.getSyncState()).webdav.status, 'idle')
      for (const method of ['runSyncWebDAV', 'fileSystemAction', 'addFolderMusics', 'createLocalMusicInfos', 'parseMusicMetadata'])
        await assert.rejects(client.remote[method](), /Forbidden/)
      await assert.rejects(client.remote.getMusicUrl({ musicInfo: { isLocal: true } }), /Local music/)
      await assert.rejects(client.remote.listAction({
        action: 'list_create', data: { position: 0, listInfos: [{ type: 'local', meta: { path: '/' } }] },
      }), /cannot be imported/)
    }
    for (const client of [adminRpc, aRpc, bRpc]) {
      assert.equal((await client.remote.getSetting())['network.proxyAllResources'], false)
      assert.equal((await client.remote.getSetting())['onlineResource.enable'], false)
      await client.remote.setSetting({ 'network.proxyAllResources': true })
      assert.equal((await client.remote.getSetting())['network.proxyAllResources'], false)
    }
    for (const [enabled, onlineResourceEnabled] of [[true, false], [false, true], [false, false]]) {
      const ghMirrorHosts = enabled ? 'https://mirror.example' : onlineResourceEnabled ? '' : defaultSetting['extension.ghMirrorHosts']
      const inputHosts = enabled ? '  https://mirror.example/\r\nhttps://mirror.example\n\n' : ghMirrorHosts
      const saved = await api('/account-api/settings', admin.cookie, 'POST', { proxyAllResources: enabled, onlineResourceEnabled, ghMirrorHosts: inputHosts })
      assert.equal(saved.status, 200)
      assert.equal((await saved.json()).ghMirrorHosts, ghMirrorHosts)
      const reopened = new Accounts(dir)
      assert.equal(reopened.state('network.proxyAllResources'), String(enabled))
      assert.equal(reopened.state('onlineResource.enable'), String(onlineResourceEnabled))
      assert.equal(reopened.state('extension.ghMirrorHosts'), ghMirrorHosts)
      reopened.close()
      for (const client of [adminRpc, aRpc, bRpc]) {
        for (let attempt = 0; attempt < 100; attempt++) {
          const setting = await client.remote.getSetting()
          if (setting['network.proxyAllResources'] === enabled && setting['onlineResource.enable'] === onlineResourceEnabled && setting['extension.ghMirrorHosts'] === ghMirrorHosts) break
          await delay(20)
        }
        assert.equal((await client.remote.getSetting())['network.proxyAllResources'], enabled)
        assert.equal((await client.remote.getSetting())['onlineResource.enable'], onlineResourceEnabled)
        await client.remote.setSetting({ 'network.proxyAllResources': !enabled, 'onlineResource.enable': !onlineResourceEnabled, 'extension.ghMirrorHosts': 'https://override.example' })
        assert.equal((await client.remote.getSetting())['extension.ghMirrorHosts'], ghMirrorHosts)
        assert.equal((await client.remote.getSetting())['network.proxyAllResources'], enabled)
        assert.equal((await client.remote.getSetting())['onlineResource.enable'], onlineResourceEnabled)
      }
      const fresh = await accounts.create(`settings-${enabled}-${onlineResourceEnabled}`, password, 'user', admin.user.id)
      const login = await api('/account-api/login', '', 'POST', { username: fresh.username, password })
      const client = await rpc({ user: fresh, cookie: login.headers.get('set-cookie')!.split(';')[0] }, [])
      assert.equal((await client.remote.getSetting())['network.proxyAllResources'], enabled)
      assert.equal((await client.remote.getSetting())['onlineResource.enable'], onlineResourceEnabled)
      assert.equal((await client.remote.getSetting())['extension.ghMirrorHosts'], ghMirrorHosts)
      await adminRpc.remote.restartExtensionHost()
      assert.equal((await adminRpc.remote.getSetting())['extension.ghMirrorHosts'], ghMirrorHosts)
    }
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
    const replacement = { ...song('Replacement source'), id: 'replacement-song-id' }
    await aRpc.remote.listAction({
      action: 'list_music_add',
      data: { id: 'love', musicInfos: [replacement], addMusicLocationType: 'bottom' },
    })
    await aRpc.remote.listAction({
      action: 'list_music_update_position',
      data: { listId: 'love', ids: [replacement.id], position: 0 },
    })
    assert.deepEqual((await a2Rpc.remote.getListMusics('love')).map((item: any) => item.id), [replacement.id, 'same-song-id'])
    await aRpc.remote.listAction({
      action: 'list_music_remove',
      data: { listId: 'love', ids: ['same-song-id'] },
    })
    assert.deepEqual((await a2Rpc.remote.getListMusics('love')).map((item: any) => item.id), [replacement.id])
    assert.equal((await bRpc.remote.getListMusics('love')).length, 0)
    assert.equal((await bRpc.remote.getListMusics('default'))[0].name, 'Bob song')
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
    await delay(50)
    const aQueueEvents = aEvents.filter((event: any) => event.action === 'set' && event.data?.list?.[0]?.itemId === 'private-queue')
    const a2QueueEvents = a2Events.filter((event: any) => event.action === 'set' && event.data?.list?.[0]?.itemId === 'private-queue')
    assert.equal(aQueueEvents.length, 1)
    assert.equal(a2QueueEvents.length, 1)
    assert.equal(bEvents.filter((event: any) => event.data?.list?.[0]?.itemId === 'private-queue').length, 0)
    await aRpc.remote.playerEvent({ action: 'playInfoUpdated', data: { index: 0 } })
    await aRpc.remote.playerEvent({ action: 'progress', data: { nowPlayTime: 123 } })
    for (let attempt = 0; attempt < 50 && (await a2Rpc.remote.getPlayInfo()).info.time !== 123; attempt++) await delay(10)
    assert.equal((await a2Rpc.remote.getPlayInfo()).info.time, 123)
    assert.notEqual((await bRpc.remote.getPlayInfo()).info.time, 123)
    await aRpc.remote.saveSearchHistoryList(['Alice private search'])
    assert.deepEqual(await a2Rpc.remote.getSearchHistoryList(), ['Alice private search'])
    assert.deepEqual((await bRpc.remote.getSearchHistoryList()) ?? [], [])
    const aRuntime = runtimes.entries.get(alice.user.id)!, bRuntime = runtimes.entries.get(bob.user.id)!
    assert.equal(aRuntime.child, undefined)
    assert.equal(bRuntime.child, undefined)
    assert.ok(aRuntime.context && bRuntime.context)
    assert.deepEqual(runtimes.status().database, { workers: 1, channels: runtimes.entries.size })
    const theme = structuredClone((await aRpc.remote.getThemeList()).themes[0])
    theme.id = 'same-theme'
    theme.name = 'Alice theme'
    await aRpc.remote.saveTheme(theme)
    await bRpc.remote.saveTheme({ ...theme, name: 'Bob theme' })
    assert.equal((await a2Rpc.remote.getThemeList()).userThemes[0].name, 'Alice theme')
    assert.equal((await bRpc.remote.getThemeList()).userThemes[0].name, 'Bob theme')
    const hotkey = await aRpc.remote.getHotKey()
    hotkey.local.enable = false
    await aRpc.remote.hotkeyConfigAction({ action: 'config', data: hotkey })
    assert.equal((await a2Rpc.remote.getHotKey()).local.enable, false)
    assert.equal((await bRpc.remote.getHotKey()).local.enable, true)
    await aRpc.remote.dislikeAction({ action: 'dislike_data_overwrite', data: 'Alice private rule' })
    assert.equal((await a2Rpc.remote.getDislikeInfo()).rules, 'alice private rule')
    assert.equal((await bRpc.remote.getDislikeInfo()).rules, '')
    const lyricSong = { id: 'same-lyric', name: 'Test', singer: '', isLocal: false, meta: { source: 'test' } }
    const lyric = { name: 'Test', singer: '', interval: '', lyric: '[00:01]Alice private lyric' }
    await aRpc.remote.setMusicLyric(lyricSong.id, lyric)
    await bRpc.remote.setMusicLyric(lyricSong.id, { ...lyric, lyric: '[00:01]Bob private lyric' })
    assert.equal((await a2Rpc.remote.getMusicLyric({ musicInfo: lyricSong })).info.lyric, lyric.lyric)
    assert.equal((await bRpc.remote.getMusicLyric({ musicInfo: lyricSong })).info.lyric, '[00:01]Bob private lyric')
    await aRpc.remote.listAction({ action: 'list_music_remove', data: { listId: 'default', ids: ['same-song-id'] } })
    assert.equal((await a2Rpc.remote.getListMusics('default')).length, 0)
    assert.equal((await bRpc.remote.getListMusics('default')).length, 1)
    for (const login of users) {
      await assert.rejects(stat(path.join(dir, 'users', login.user.id, 'app', 'backup', 'db_backups')), {
        code: 'ENOENT',
      })
    }
    media.listen(0, '127.0.0.1')
    await once(media, 'listening')
    const mediaUrl = `http://127.0.0.1:${(media.address() as { port: number }).port}/test.mp3`
    const blockedMedia = await api(`/u/${alice.user.id}/api/p_url/${encodeURIComponent(mediaUrl)}`, alice.cookie)
    assert.equal(blockedMedia.status, 500)
    runtimes.allowedMediaOrigins = [new URL(mediaUrl).origin]
    await runtimes.stop(alice.user.id)
    const restartedAlice = await rpc(alice, [])
    assert.equal((await restartedAlice.remote.getPlayInfo()).info.time, 123)
    assert.equal((await restartedAlice.remote.getThemeList()).userThemes[0].name, 'Alice theme')
    assert.equal((await restartedAlice.remote.getHotKey()).local.enable, false)
    assert.equal((await restartedAlice.remote.getDislikeInfo()).rules, 'alice private rule')
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
    const databaseHost = (runtimes as unknown as { database: { worker: import('node:worker_threads').Worker } }).database
    await databaseHost.worker.terminate()
    for (let attempt = 0; runtimes.entries.size && attempt < 100; attempt++) await delay(20)
    assert.equal(runtimes.entries.size, 0, 'database worker failure must release runtimes with dead channels')
    runtimes.retry(bob.user.id)
    const recoveredBob = await rpc({ user: bob.user, cookie: newBobCookie }, [])
    assert.equal((await recoveredBob.remote.getListMusics('default'))[0].name, 'Bob song')
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
  const runtimes = new Runtimes(dir, path.join(root, 'build/server/index.js'))
  const publications = new Publications(accounts, runtimes)
  let sourceVersion: string | undefined
  runtimes.sources.switch = async (version) => { sourceVersion = version }
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
    const snapshots = path.join(dir, 'publications')
    await mkdir(path.join(snapshots, 'old-snapshot'), { recursive: true })
    await publications.publish(admin)
    const previous = publications.status().version!
    assert.deepEqual(await readdir(snapshots), [previous])
    assert.equal(sourceVersion, previous)
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
    assert.equal(sourceVersion, previous)
    assert.equal(publications.status().running, false)
    assert.deepEqual(await readdir(snapshots), [previous], 'failed snapshots must be removed after rollback')
    assert((await runtimes.get(alice)).port)
    await publications.publish(admin)
    assert.notEqual(publications.status().version, previous)
    assert.deepEqual(await readdir(snapshots), [publications.status().version], 'successful publication must remove old snapshots')
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
              resource: [{ id: 'test', name: 't(wyName)', resource: id === 'online-metadata' ? ['musicSearch'] : ['musicUrl'] }],
            },
          })
        )
        await mkdir(path.join(draft, 'ext', id, 'i18n'), { recursive: true })
        await writeFile(path.join(draft, 'ext', id, 'i18n/en-us.json'), JSON.stringify({ wyName: 'Test source' }))
        await writeFile(path.join(draft, 'ext', id, 'i18n/zh-cn.json'), JSON.stringify({ wyName: '测试音源' }))
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
      const extensionEvents: any[] = []
      const rpc = createMessage2Call<any>({
        exposeObj: { extensionEvent: (event: any) => extensionEvents.push(event) },
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
      assert.equal(extensions.find((item: any) => item.id === 'online-metadata').i18nMessages.wyName, 'Test source')
      await rpc.remote.inited()
      await rpc.remote.setSetting({ 'common.langId': 'zh-cn' })
      for (let attempt = 0; attempt < 100; attempt++) {
        if (extensionEvents.some((event) => event.action === 'listSet' && event.data.some((ext: any) => ext.id === 'online-metadata' && ext.i18nMessages?.wyName === '测试音源'))) break
        await delay(20)
      }
      const translated = extensionEvents.find((event) => event.action === 'listSet' && event.data.some((ext: any) => ext.id === 'online-metadata' && ext.i18nMessages?.wyName === '测试音源'))
      assert(translated, 'Ordinary users receive translated extension names after a language change')
      assert(translated.data.every((item: any) => !item.directory && !item.dataDirectory && !item.contributes?.settings))
      const url = await rpc.remote.getMusicUrl({ musicInfo: song, quality: '128k', isRefresh: true })
      assert.equal(url.url, 'https://example.com/test.mp3')
      const privateFile = path.join(dir, 'users', user.id, 'app/extension/datas/online-metadata/storage/private.json')
      await mkdir(path.dirname(privateFile), { recursive: true })
      await writeFile(privateFile, 'private')
      ws.terminate()
      await publications.publish(admin)
      assert.equal(await readFile(privateFile, 'utf8'), 'private')
      const previous = publications.status().version
      const scriptFile = path.join(draft, 'ext/online-metadata/index.js')
      const workingScript = await readFile(scriptFile, 'utf8')
      await writeFile(scriptFile, "throw new Error('Injected public source startup failure')")
      await assert.rejects(publications.publish(admin), /Publication failed/)
      assert.equal(publications.status().version, previous)
      assert.equal(runtimes.sources.status().version, previous)
      const restored = await runtimes.sources.call('resourceAction', ['musicUrl', {
        extensionId: 'lx-api-source-loader', source: 'test', musicInfo: song, quality: '128k',
      }])
      assert.equal((restored.value as { url: string }).url, 'https://example.com/test.mp3')
      await writeFile(scriptFile, workingScript)
      await runtimes.close()
      const restarted = new Runtimes(dir, path.join(root, 'build/server/index.js'))
      try {
        const publication = new Publications(accounts, restarted)
        restarted.prepare = (account) => publication.apply(account)
        await restarted.get(user)
        assert.equal(restarted.sources.status().version, previous)
        assert.equal(restarted.sources.status().workers, 1)
      } finally { await restarted.close() }
    } finally {
      for (const socket of sockets) socket.terminate()
      await runtimes.close()
      accounts.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
)
