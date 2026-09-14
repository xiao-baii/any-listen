import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { SharedExtensions } from '../src/accounts/sharedExtensions'

test(
  'one public host serializes calls, isolates cancellation, rejects personal access and replaces versions',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'any-listen-shared-source-'))
    const host = new SharedExtensions(path.join(process.env.ACCOUNT_TEST_ROOT!, 'build/server/extension-service.worker.js'), root)
    const directory = path.join(root, 'release')
    const manifest = {
      id: 'online-metadata',
      name: 'Fixture',
      main: 'index.js',
      version: '1.0.0',
      contributes: { resource: [{ id: 'test', name: 'Test', resource: ['musicUrl'] }] },
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
        api.registerResourceAction({ musicUrl: async ({ musicInfo }) => {
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
      const cancelled = new AbortController()
      const first = host.call('resourceAction', request())
      const second = host.call('resourceAction', request(), 'en-us', cancelled.signal)
      const secondRejected = assert.rejects(second, /cancelled/)
      cancelled.abort(new Error('cancelled'))
      const third = host.call('resourceAction', request())
      assert.equal(((await first).value as { url: string }).url, 'https://example.com/1.mp3')
      await secondRejected
      assert.equal(((await third).value as { url: string }).url, 'https://example.com/2.mp3')
      await assert.rejects(host.call('getPlayInfo', []), /forbidden/)
      const blocked = host.call('resourceAction', request('hang'))
      const rejected = assert.rejects(blocked)
      await new Promise((resolve) => setTimeout(resolve, 50))
      await host.switch('two', directory, [], '')
      await rejected
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
