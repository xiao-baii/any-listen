import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createMessage2Call } from 'message2call'
import WebSocket from 'ws'

import { Accounts } from '../src/accounts/database'
import { createGateway } from '../src/accounts/gateway'
import { Runtimes } from '../src/accounts/runtime'

test(
  'official extension packages publish, initialize LX script, resolve and stream private media',
  { timeout: 120000 },
  async () => {
    const packages = process.env.ACCOUNT_EXTENSION_PACKAGES
    assert(packages, 'Set ACCOUNT_EXTENSION_PACKAGES to a directory containing loader/ and metadata/ packages')
    const root = process.env.ACCOUNT_TEST_ROOT!
    const dir = await mkdtemp(path.join(tmpdir(), 'any-listen-official-'))
    const accounts = new Accounts(dir)
    const runtimes = new Runtimes(dir, path.join(root, 'build/server/index.js'))
    const gateway = createGateway(accounts, runtimes, path.join(root, 'build/public'))
    const media = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '10' })
      res.end('0123456789')
    })
    let socket: WebSocket | undefined
    try {
      media.listen(0, '127.0.0.1')
      gateway.server.listen(0, '127.0.0.1')
      await once(gateway.server, 'listening')
      const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`
      const musicUrl = `http://127.0.0.1:${(media.address() as { port: number }).port}/fixture.mp3`
      runtimes.allowedMediaOrigins = [new URL(musicUrl).origin]
      const password = 'Official-fixture-12345'
      const admin = await accounts.create('admin', password, 'admin', null)
      const user = await accounts.create('alice', password, 'user', admin.id)
      await accounts.password(user.id, password, false, user.id)
      const draft = path.join(dir, 'users', admin.id, 'app/extension')
      for (const [id, folder] of [
        ['online-metadata', 'metadata'],
        ['lx-api-source-loader', 'loader'],
      ]) {
        const source = path.resolve(packages, folder)
        const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
        assert.equal(manifest.id, id)
        await mkdir(path.join(draft, 'ext'), { recursive: true })
        await cp(source, path.join(draft, 'ext', id), { recursive: true })
        console.log(`${id} ${manifest.version}`)
      }
      const script = `/**\n * @name Controlled source\n * @version 1.0.0\n */\nlx.on(lx.EVENT_NAMES.request, async () => ${JSON.stringify(musicUrl)});\nlx.send(lx.EVENT_NAMES.inited, {status:true,sources:{kw:{name:'Test',type:'music',actions:['musicUrl'],qualitys:['128k']}}});`
      const scriptId = createHash('md5').update(script.trim()).digest('hex')
      const data = path.join(draft, 'datas/lx-api-source-loader')
      await mkdir(path.join(data, 'storage/scripts'), { recursive: true })
      await writeFile(path.join(data, 'storage/scripts', scriptId), script)
      await writeFile(
        path.join(data, 'configuration.json'),
        JSON.stringify({
          enabledScripts: [scriptId],
          importedScriptSources: [{ id: scriptId, name: 'Controlled source', fileName: 'fixture.js' }],
          enabledCache: true,
        })
      )
      await writeFile(
        path.join(draft, 'extensions.json'),
        JSON.stringify(['online-metadata', 'lx-api-source-loader'].map((id) => ({ id, enabled: true })))
      )
      await gateway.publications.publish(admin)
      const login = await accounts.login(user.username, password, '127.0.0.1', 'official-test')
      const cookie = `anylisten_session=${login.token}`
      socket = new WebSocket(origin.replace('http:', 'ws:') + `/u/${user.id}/api/ipc?t=main`, {
        headers: { Cookie: cookie, Origin: origin },
      })
      const rpc = createMessage2Call<any>({
        exposeObj: {},
        timeout: 10000,
        sendMessage: (value) => socket!.send(JSON.stringify(value)),
      })
      socket.on('message', (value) => {
        if (value.toString() !== 'ping') rpc.message(JSON.parse(value.toString()))
      })
      await once(socket, 'open')
      const resources = await rpc.remote.getResourceList()
      assert(resources.resources.musicSearch.some((item: any) => item.extensionId === 'online-metadata'))
      const result = await rpc.remote.getMusicUrl({
        musicInfo: {
          id: 'controlled',
          name: 'Controlled',
          singer: 'Test',
          interval: '00:10',
          isLocal: false,
          meta: { musicId: 'controlled', source: 'kw', albumName: 'Test', qualitys: { '128k': { sizeStr: null } } },
        },
        quality: '128k',
        isRefresh: true,
      })
      assert.match(result.url, /^al-ps-host:\/api\/p_static\//)
      const mediaPath = result.url.slice(result.url.indexOf('/api/'))
      const response = await fetch(`${origin}/u/${user.id}${mediaPath}`, { headers: { Cookie: cookie } })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), '0123456789')
      assert.match(response.headers.get('cache-control')!, /no-store/)
      assert.equal((await fetch(`${origin}/u/${user.id}${mediaPath}`)).status, 401)
      await gateway.publications.publish(admin)
      assert(gateway.publications.status().version)
    } finally {
      socket?.terminate()
      media.close()
      await gateway.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
)
