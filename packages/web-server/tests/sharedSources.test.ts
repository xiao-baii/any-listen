import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { SharedExtensions } from '../src/accounts/sharedExtensions'

test('source cache expires idle files, renews reads and drains cleanup on stop', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'any-listen-source-cache-'))
  const host = new SharedExtensions('unused-worker', root)
  const cache = host as unknown as {
    writeCache: (name: string, data: Uint8Array) => Promise<string>
    result: (token: string) => { assets: Record<string, { file: string }> }
    cleanCache: () => Promise<void>
    cacheTimer: ReturnType<typeof setInterval> | undefined
    cleaningCache: Promise<void> | undefined
  }
  const idle = 48 * 60 * 60_000
  const start = Date.now()
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: start })
  const write = async () => {
    const token = await cache.writeCache('song.mp3', Buffer.from('fixture audio'))
    return cache.result(token).assets[token].file
  }
  const consume = async (file: string) => {
    const stream = host.openFile(file)!
    let data = ''
    for await (const chunk of stream) data += chunk
    return data
  }
  try {
    await mkdir(path.join(root, 'source-cache'))
    const expired = await write()
    const renewed = await write()
    const active = await write()
    const missing = await write()
    const icon = path.join(root, 'icon.png')
    await writeFile(icon, 'icon')
    await rm(missing)
    assert.ok(cache.cacheTimer)
    t.mock.timers.setTime(start + idle - 1)
    assert.equal(await consume(renewed), 'fixture audio')
    const stream = host.openFile(active)!
    await once(stream, 'open')
    t.mock.timers.setTime(start + idle)
    assert.equal(host.openFile(expired), undefined)
    const firstCleanup = cache.cleanCache()
    await Promise.all([firstCleanup, cache.cleanCache()])
    await assert.rejects(readFile(expired), { code: 'ENOENT' })
    assert.equal((await readFile(active)).toString(), 'fixture audio')
    assert.equal(await consume(renewed), 'fixture audio')
    assert.equal(await consume(icon), 'icon')
    const closed = once(stream, 'close')
    stream.destroy()
    await closed
    t.mock.timers.tick(idle + 10 * 60_000)
    await cache.cleanCache()
    await assert.rejects(readFile(renewed), { code: 'ENOENT' })
    await assert.rejects(readFile(active), { code: 'ENOENT' })
    assert.equal(await consume(icon), 'icon')
    const last = await write()
    t.mock.timers.tick(idle + 10 * 60_000)
    await host.stop()
    await assert.rejects(readFile(last), { code: 'ENOENT' })
    assert.equal(cache.cacheTimer, undefined)
    assert.equal(cache.cleaningCache, undefined)
  } finally {
    await host.close()
    t.mock.timers.reset()
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'one public host serializes calls, isolates cancellation, rejects personal access and replaces versions',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'any-listen-shared-source-'))
    const logDirectory = path.join(root, 'persistent-log', 'extensions')
    const host = new SharedExtensions(
      path.join(process.env.ACCOUNT_TEST_ROOT!, 'build/server/extension-service.worker.js'),
      root,
      logDirectory
    )
    const directory = path.join(root, 'release')
    const manifest = {
      id: 'online-metadata',
      name: 'Fixture',
      main: 'index.js',
      version: '1.0.0',
      contributes: { resource: [{ id: 'test', name: 'Test', resource: ['musicUrl', 'singerSearch', 'singer'] }] },
    }
    const request = (name = '') => [
      'musicUrl',
      {
        extensionId: 'online-metadata',
        source: 'test',
        musicInfo: { id: 'test', name, singer: '', interval: null, isLocal: false, meta: { source: 'test', musicId: 'test' } },
      },
    ]
    try {
      for (const id of ['online-metadata', 'lx-api-source-loader']) {
        await mkdir(path.join(directory, 'ext', id), { recursive: true })
        await writeFile(path.join(directory, 'ext', id, 'manifest.json'), JSON.stringify({ ...manifest, id }))
        await writeFile(
          path.join(directory, 'ext', id, 'index.js'),
          `
        const api = require('any-listen'); let calls = 0;
        api.logcat.info('extension-log-persistence-marker');
        api.registerResourceAction({
          singerSearch: async ({ keyword, page }) => ({ list: [{ id: 'artist', name: keyword }], total: 1, page, limit: 30 }),
          singer: async ({ id, page }) => ({ list: [], info: { id, name: 'Fixture singer' }, total: 0, page, limit: 30 }),
          musicUrl: async ({ musicInfo }) => {
          if (musicInfo.name === 'invalid') return { url: '', quality: 'invalid' };
          if (musicInfo.name === 'private') await api.app.showInputDialog({ title: 'Private login' });
          if (musicInfo.name === 'hang') return new Promise(() => {});
          const n = ++calls;
          await new Promise(resolve => setTimeout(resolve, 20));
          return { url: 'https://example.com/' + n + '.mp3', quality: '128k' };
        } });
      `
        )
      }
      await writeFile(
        path.join(directory, 'extensions.json'),
        JSON.stringify([
          { id: 'online-metadata', enabled: true },
          { id: 'lx-api-source-loader', enabled: false },
        ])
      )
      const snapshot = await readFile(path.join(directory, 'extensions.json'), 'utf8')
      await host.switch('one', directory, [], '')
      assert.equal(await readFile(path.join(directory, 'extensions.json'), 'utf8'), snapshot)
      const singerParams = { extensionId: 'online-metadata', source: 'test', page: 1 }
      const searchResult = await host.call('resourceAction', ['singerSearch', { ...singerParams, keyword: 'Fixture singer' }])
      assert.equal(
        (searchResult.value as AnyListen.IPCExtension.ListCommonResult<AnyListen.Resource.SingerItem>).list[0].id,
        'artist'
      )
      const singerResult = await host.call('resourceAction', ['singer', { ...singerParams, id: 'artist' }])
      assert.equal((singerResult.value as AnyListen.IPCExtension.SingerDetailResult).info.name, 'Fixture singer')
      const cancelled = new AbortController()
      const first = host.call('resourceAction', request())
      const second = host.call('resourceAction', request(), 'en-us', cancelled.signal)
      const secondRejected = assert.rejects(second, /cancelled/)
      cancelled.abort(new Error('cancelled'))
      const third = host.call('resourceAction', request())
      assert.equal(((await first).value as { url: string }).url, 'https://example.com/1.mp3')
      await secondRejected
      assert.equal(((await third).value as { url: string }).url, 'https://example.com/2.mp3')
      await assert.rejects(host.call('resourceAction', request('invalid')), /url|quality/)
      await assert.rejects(host.call('getPlayInfo', []), /forbidden/)
      const blocked = host.call('resourceAction', request('hang'))
      const rejected = assert.rejects(blocked)
      await new Promise((resolve) => setTimeout(resolve, 50))
      await host.switch('two', directory, [], '')
      await rejected
      const logFile = path.join(logDirectory, 'online-metadata', 'output.log')
      const persisted = await readFile(logFile, 'utf8')
      assert.equal(persisted.split('extension-log-persistence-marker').length - 1, 2)
      const pageLogs = (await host.call('getExtensionLastLogs', ['online-metadata'])).value as Array<{ logs: string }>
      assert.match(pageLogs[0].logs, /extension-log-persistence-marker/)
      await host.call('clearExtensionLogs', ['online-metadata'])
      assert.equal(await readFile(logFile, 'utf8'), '')
      assert.equal(host.status().workers, 1)
      assert.equal(((await host.call('resourceAction', request())).value as { url: string }).url, 'https://example.com/1.mp3')
      await assert.rejects(host.call('resourceAction', request('private')), /personal capability/)
      await host.stop()
      await writeFile(
        path.join(directory, 'ext/online-metadata/manifest.json'),
        JSON.stringify({ ...manifest, grant: ['music_list'] })
      )
      await assert.rejects(host.switch('private', directory, [], ''), /personal capabilities/)
      assert.equal(host.status().workers, 0)
      assert.deepEqual((await host.call('getLocalExtensionList', [])).value, [])
      await writeFile(path.join(directory, 'ext/online-metadata/manifest.json'), JSON.stringify(manifest))
      await host.switch('restored', directory, [], '')
      const saturation = Array.from({ length: 128 }, () => host.call('resourceAction', request()))
      const draining = Promise.allSettled(saturation)
      await assert.rejects(host.call('resourceAction', request()), /queue is full/)
      await host.stop()
      await draining
      assert.equal(host.status().queued, 0)
      await host.close()
      await assert.rejects(async () => host.switch('closed', directory, [], ''), /shutting down/)
    } finally {
      await host.stop()
      await rm(root, { recursive: true, force: true })
    }
  }
)
