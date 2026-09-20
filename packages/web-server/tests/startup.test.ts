import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'

import { Accounts } from '../src/accounts/database'
import { createGateway } from '../src/accounts/gateway'
import { Runtimes } from '../src/accounts/runtime'
import { createIPC } from '../src/preload/ipc'
import { disconnect } from '../src/preload/ws'

test('gateway caches versioned build assets but revalidates entry points and protects account data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'any-listen-startup-'))
  const accounts = new Accounts(dir)
  const runtimes = new Runtimes(dir, path.join(dir, 'index.js'))
  const publicDir = path.join(dir, 'public')
  const gateway = createGateway(accounts, runtimes, publicDir)
  try {
    await mkdir(publicDir)
    const files = ['index.html', 'favicon.ico', 'ws.js', 'index-1234abcd.js', 'view-main.ipc.1234abcd.js',
      'ws.1234abcd.js', 'index-1234abcd.css', 'Inter-1234abcd.ttf']
    for (const file of files) await writeFile(path.join(publicDir, file), file)
    const user = await accounts.create('admin', 'password', 'admin', null)
    const login = await accounts.login('admin', 'password', 'ip', 'browser')
    const headers = { Cookie: `anylisten_session=${login.token}` }
    gateway.server.listen(0, '127.0.0.1')
    await once(gateway.server, 'listening')
    const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`
    for (const prefix of ['/', `/u/${user.id}/`]) {
      for (const file of ['', ...files]) {
        for (const method of ['GET', 'HEAD']) {
          const response = await fetch(origin + prefix + file, { headers, method })
          assert.equal(response.status, 200)
          assert.equal(response.headers.get('cache-control'), file.includes('1234abcd')
            ? 'public, max-age=5184000, immutable' : 'no-cache', prefix + file)
          assert.equal(await response.text(), method === 'HEAD' ? '' : file || 'index.html')
        }
      }
    }
    const me = await fetch(origin + '/account-api/me', { headers })
    assert.equal(me.headers.get('cache-control'), 'no-store')
    assert.equal((await me.json()).user.id, user.id)
    accounts.revoke(login.session.id, user.id)
    const denied = await fetch(origin + `/u/${user.id}/index-1234abcd.js`, { headers })
    assert.equal(denied.status, 401)
    assert.equal(denied.headers.get('cache-control'), 'no-store')
  } finally {
    await gateway.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('IPC reuses the initial account check and checks the session again on reconnect', { timeout: 10000 }, async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}/u/alice/`
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/account-api/me') return Response.json({ user: { id: 'alice', username: 'Alice' } })
    assert(String(url).includes('/proxyUrlToken?'))
    return new Response('ok')
  })
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
  const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname: '/u/alice/', assign() { assert.fail('unexpected redirect') } } })
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: WebSocket })
  try {
    let onConnected: () => void
    const first = new Promise<void>(resolve => { onConnected = resolve })
    createIPC({ host, authCode: '', winType: 'main', exposeObj: {} as AnyListen.IPC.ClientIPCActions,
      initialKeyInfo: { serverId: 'alice', serverName: 'Alice', token: 'managed-session' },
      onConnected() { onConnected() }, onDisconnected() {},
      onFailed(message) { assert.fail(message) }, onLogout() { assert.fail('unexpected logout') } })
    await first
    const calls = () => (fetch as unknown as { mock: { calls: Array<{ arguments: unknown[] }> } }).mock.calls
      .filter(call => call.arguments[0] === '/account-api/me').length
    assert.equal(calls(), 0, 'initial connection must not duplicate initAccount request')
    const reconnected = new Promise<void>(resolve => { onConnected = resolve })
    for (const socket of server.clients) socket.terminate()
    await reconnected
    assert.equal(calls(), 1, 'reconnect must check the current session')
  } finally {
    await disconnect()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    for (const [key, descriptor] of [['location', locationDescriptor], ['WebSocket', socketDescriptor]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
