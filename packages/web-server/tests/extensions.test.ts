import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createMessage2Call } from 'message2call'
import WebSocket from 'ws'

import { Accounts } from '../src/accounts/database'
import { createGateway } from '../src/accounts/gateway'
import { Runtimes } from '../src/accounts/runtime'
import { createDraftExtensions } from '../src/accounts/draftExtensions'
import { unpack } from '@any-listen/nodejs/tar'

test(
  'official extension packages publish, initialize LX script, resolve and stream private media',
  { timeout: 120000 },
  async () => {
    const packages = process.env.ACCOUNT_EXTENSION_PACKAGES
    assert(packages, 'Set ACCOUNT_EXTENSION_PACKAGES to a directory containing loader/ and metadata/ packages')
    const root = process.env.ACCOUNT_TEST_ROOT!
    const dir = await mkdtemp(path.join(tmpdir(), 'any-listen-official-'))
    const accounts = new Accounts(dir)
    let remoteScript = ''
    const media = http.createServer((req, res) => {
      if (req.url === '/source.js') { res.end(remoteScript); return }
      if (req.url === '/too-large.js') { res.end('x'.repeat(1024 * 1024 + 1)); return }
      if (req.url === '/missing.js') { res.writeHead(404); res.end(); return }
      if (req.url === '/redirect.js') { res.writeHead(302, { Location: 'http://127.0.0.2/blocked.js' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '10' })
      res.end('0123456789')
    })
    media.listen(0, '127.0.0.1')
    await once(media, 'listening')
    const musicUrl = `http://127.0.0.1:${(media.address() as { port: number }).port}/fixture.mp3`
    const previousOrigins = process.env.ANYLISTEN_ALLOWED_MEDIA_ORIGINS
    process.env.ANYLISTEN_ALLOWED_MEDIA_ORIGINS = JSON.stringify([new URL(musicUrl).origin])
    const runtimes = new Runtimes(dir, path.join(root, 'build/server/index.js'))
    const gateway = createGateway(accounts, runtimes, path.join(root, 'build/public'))
    if (previousOrigins === undefined) delete process.env.ANYLISTEN_ALLOWED_MEDIA_ORIGINS
    else process.env.ANYLISTEN_ALLOWED_MEDIA_ORIGINS = previousOrigins
    let socket: WebSocket | undefined
    let otherSocket: WebSocket | undefined
    let adminSocket: WebSocket | undefined
    try {
      gateway.server.listen(0, '127.0.0.1')
      await once(gateway.server, 'listening')
      const origin = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`
      const password = 'Official-fixture-12345'
      const admin = await accounts.create('admin', password, 'admin', null)
      const user = await accounts.create('alice', password, 'user', admin.id)
      const other = await accounts.create('bobby', password, 'user', admin.id)
      const draft = path.join(dir, 'users', admin.id, 'app/extension')
      const installer = createDraftExtensions({ entry: path.join(root, 'build/server/extension-service.worker.js'),
        directory: path.join(dir, 'install-check'), origins: [], mirrors: () => '', locale: () => 'en-us', icon: () => '' })
      try {
        const installed = await installer.importPackage(await readFile(path.join(packages, '../metadata.alix')))
        assert.equal(installed.id, 'online-metadata')
        assert.equal(installed.loaded, false)
        await assert.rejects(installer.call('installExtension', [{ directory: installed.directory }]), /expired/)
      } finally { await installer.close() }
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
      let locale: AnyListen.Locale = 'zh-cn'
      const editor = createDraftExtensions({ entry: path.join(root, 'build/server/extension-service.worker.js'),
        directory: draft, origins: [], mirrors: () => '', locale: () => locale, icon: () => '' })
      try {
        const list = await editor.call('getLocalExtensionList', []) as any[]
        assert.equal(list.length, 2)
        assert(list.every(extension => !extension.loaded), 'Draft inspection does not evaluate extensions')
        const cacheLabel = (items: any[]) => items.find(extension => extension.id === 'lx-api-source-loader').i18nMessages['settings.enabledCache']
        const chineseMessages = JSON.parse(await readFile(path.join(packages, 'loader/i18n/zh-cn.json'), 'utf8'))
        assert.equal(cacheLabel(list), chineseMessages['settings.enabledCache'])
        locale = 'en-us'
        assert.equal(cacheLabel(await editor.call('getLocalExtensionList', []) as any[]), 'Enable song cache')
        locale = 'zh-cn'
        assert.equal(cacheLabel(await editor.call('getLocalExtensionList', []) as any[]), chineseMessages['settings.enabledCache'])
        await editor.call('enableExtension', ['lx-api-source-loader'])
        assert((await editor.call('getLocalExtensionList', []) as any[]).every(extension => !extension.loaded))
        await assert.rejects(editor.call('executeCommand', ['lx-api-source-loader.addRemoteSource']), /publication/)
        const imported = await editor.importScript('second.js', script.replace('Controlled source', 'Second source'))
        assert.equal(imported.name, 'Second source')
        assert.equal(imported.fileName, 'second.js')
        await assert.rejects(editor.importScript('second.js', script.replace('Controlled source', 'Second source')), /already imported/)
        remoteScript = script.replace('Controlled source', 'Remote source')
        const remoteUrl = new URL('/source.js', musicUrl).href
        const remote = await editor.importRemoteScript(remoteUrl)
        assert.equal(remote.name, 'Remote source')
        assert.equal(remote.fileName, 'source.js')
        await assert.rejects(editor.importRemoteScript(remoteUrl), /already imported/)
        await assert.rejects(editor.importRemoteScript('file:///private.js'), /HTTP/)
        await assert.rejects(editor.importRemoteScript('https://user:secret@example.com/source.js'), /credentials/)
        await assert.rejects(editor.importRemoteScript('http://127.0.0.2/private.js'), /Private network/)
        await assert.rejects(editor.importRemoteScript(new URL('/redirect.js', musicUrl).href), /Private network/)
        await assert.rejects(editor.importRemoteScript(new URL('/missing.js', musicUrl).href), /HTTP 404/)
        await assert.rejects(editor.importRemoteScript(new URL('/too-large.js', musicUrl).href), /1 MiB/)
        remoteScript = '<html>Not a source</html>'
        await assert.rejects(editor.importRemoteScript(remoteUrl), /metadata/)
        const archive = path.join(dir, 'sources.tar.gz'), exported = path.join(dir, 'exported')
        await writeFile(archive, await editor.exportScripts())
        await mkdir(exported)
        await unpack(archive, exported)
        const contents = await Promise.all((await readdir(exported)).map(name => readFile(path.join(exported, name), 'utf8')))
        assert.deepEqual(new Set(contents), new Set([script, script.replace('Controlled source', 'Second source'), script.replace('Controlled source', 'Remote source')]))
        await editor.call('updateExtensionSettings', ['lx-api-source-loader', { enabledScripts: [imported.id] }])
        assert.equal(editor.status().workers, 1)
      } finally { await editor.close() }
      assert.equal(editor.status().workers, 0)
      const adminRuntime = await runtimes.get(admin)
      const adminLogin = await accounts.login(admin.username, password, '127.0.0.1', 'official-test')
      const adminHeaders = { Cookie: `anylisten_session=${adminLogin.token}`, Origin: origin }
      remoteScript = script.replace('Controlled source', 'HTTP remote source')
      const remoteResponse = await fetch(`${origin}/account-api/source-remote`, {
        method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: new URL('/source.js', musicUrl).href }),
      })
      assert.equal(remoteResponse.status, 201)
      assert.equal((await remoteResponse.json() as { name: string }).name, 'HTTP remote source')
      const localResponse = await fetch(`${origin}/account-api/source-script?name=original.js`, {
        method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'text/javascript' },
        body: script.replace('Controlled source', 'HTTP local source'),
      })
      assert.equal(localResponse.status, 201)
      assert.equal((await localResponse.json() as { fileName: string }).fileName, 'original.js')
      const exportResponse = await fetch(`${origin}/account-api/source-scripts`, { headers: adminHeaders })
      assert.equal(exportResponse.status, 200)
      assert.match(exportResponse.headers.get('content-disposition')!, /lx-sources.tar.gz/)
      assert.equal(exportResponse.headers.get('cache-control'), 'no-store')
      assert((await exportResponse.arrayBuffer()).byteLength > 0)
      assert.equal(runtimes.sources.status().workers, 0, 'Import and export only edit the draft')
      assert.equal(runtimes.status().active[0].process, process.pid)
      await gateway.publications.publish(admin)
      assert.equal(runtimes.status().draftWorkers, 0)
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
      await assert.rejects(rpc.remote.getExtensionLastLogs(), /Forbidden/)
      await assert.rejects(rpc.remote.clearExtensionLogs(), /Forbidden/)
      adminSocket = new WebSocket(origin.replace('http:', 'ws:') + `/u/${admin.id}/api/ipc?t=main`, { headers: adminHeaders })
      const adminRpc = createMessage2Call<any>({ exposeObj: {}, timeout: 10000,
        sendMessage: value => adminSocket!.send(JSON.stringify(value)),
      })
      adminSocket.on('message', value => { if (value.toString() !== 'ping') adminRpc.message(JSON.parse(value.toString())) })
      await once(adminSocket, 'open')
      const logs = await adminRpc.remote.getExtensionLastLogs('lx-api-source-loader')
      assert.match(logs[0].logs, /Init successfully/)
      await adminRpc.remote.clearExtensionLogs('lx-api-source-loader')
      assert.equal((await adminRpc.remote.getExtensionLastLogs('lx-api-source-loader'))[0].logs, '')
      assert(resources.resources.musicSearch.some((item: any) => item.extensionId === 'online-metadata'))
      const sharedResult = await runtimes.sources.call('resourceAction', ['musicUrl', {
        extensionId: 'lx-api-source-loader', source: 'kw', quality: '128k',
        musicInfo: { id: 'controlled', name: 'Controlled', singer: 'Test', interval: '00:10', isLocal: false,
          meta: { musicId: 'controlled', source: 'kw', albumName: 'Test', qualitys: { '128k': { sizeStr: null } } } },
      }])
      assert(sharedResult.value)
      const request = {
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
      }
      const otherLogin = await accounts.login(other.username, password, '127.0.0.1', 'official-test')
      const otherCookie = `anylisten_session=${otherLogin.token}`
      otherSocket = new WebSocket(origin.replace('http:', 'ws:') + `/u/${other.id}/api/ipc?t=main`, {
        headers: { Cookie: otherCookie, Origin: origin },
      })
      const otherRpc = createMessage2Call<any>({ exposeObj: {}, timeout: 10000,
        sendMessage: (value) => otherSocket!.send(JSON.stringify(value)),
      })
      otherSocket.on('message', (value) => {
        if (value.toString() !== 'ping') otherRpc.message(JSON.parse(value.toString()))
      })
      await once(otherSocket, 'open')
      const [result, otherResult] = await Promise.all([rpc.remote.getMusicUrl(request), otherRpc.remote.getMusicUrl(request)])
      assert.equal(runtimes.sources.status().workers, 1)
      assert.notEqual(result.url, otherResult.url, 'Shared source results receive account-owned proxy URLs')
      assert.match(result.url, /^al-ps-host:\/api\/p_static\//)
      const mediaPath = result.url.slice(result.url.indexOf('/api/'))
      const response = await fetch(`${origin}/u/${user.id}${mediaPath}`, { headers: { Cookie: cookie } })
      assert.equal(response.status, 200)
      assert.equal(await response.text(), '0123456789')
      assert.match(response.headers.get('cache-control')!, /no-store/)
      assert.equal((await fetch(`${origin}/u/${user.id}${mediaPath}`)).status, 401)
      assert.equal((await fetch(`${origin}/u/${other.id}${mediaPath}`, { headers: { Cookie: otherCookie } })).status, 404)
      accounts.revoke(login.session.id, user.id)
      assert.equal((await fetch(`${origin}/u/${user.id}${mediaPath}`, { headers: { Cookie: cookie } })).status, 401)
      const otherPath = otherResult.url.slice(otherResult.url.indexOf('/api/'))
      assert.equal(await (await fetch(`${origin}/u/${other.id}${otherPath}`, { headers: { Cookie: otherCookie } })).text(), '0123456789')
      await gateway.publications.publish(admin)
      assert(gateway.publications.status().version)
      const published = gateway.publications.status().version
      const oldHost = (runtimes.sources as any).host
      await oldHost.worker.terminate()
      for (let attempt = 0; attempt < 160; attempt++) {
        if (runtimes.sources.status().version === published && !runtimes.sources.status().error && !gateway.publications.status().running) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(runtimes.sources.status().version, published, 'Worker crash recovers committed sources')
      assert.equal(runtimes.sources.status().error, null)
      assert.equal(new Set(runtimes.status().active.map(runtime => runtime.process)).size, 1)
    } finally {
      socket?.terminate()
      otherSocket?.terminate()
      adminSocket?.terminate()
      media.close()
      await gateway.close()
      await rm(dir, { recursive: true, force: true })
    }
  }
)
