import assert from 'node:assert/strict'
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createDraftExtensions } from '../src/accounts/draftExtensions'
import { snapshotExtensions } from '../src/accounts/publications'
import { SharedExtensions } from '../src/accounts/sharedExtensions'
import { verifyExtensions } from '../src/accounts/extensionHealth'

test('health checks only enabled installed extensions', async () => {
  const check = (items: unknown[]) => verifyExtensions({
    getLocalExtensionList: async () => items as AnyListen.Extension.Extension[],
    getExtensionConfigValues: async () => { throw new Error('LX config must not be read') },
  }, [])
  await check([])
  await check([{ id: 'third-party', enabled: true, loaded: true }])
  await check([{ id: 'lx-api-source-loader', enabled: false, loaded: false }])
  await assert.rejects(check([{ id: 'third-party', enabled: true, loaded: false }]), /third-party/)
})

test('real ALIX installs, updates, publishes, disables and uninstalls without the original extensions', { timeout: 120000 }, async () => {
  const root = process.env.ACCOUNT_TEST_ROOT!
  const directory = await mkdtemp(path.join(tmpdir(), 'singer-extension-'))
  const draft = path.join(directory, 'draft')
  const worker = path.join(root, 'build/server/extension-service.worker.js')
  const installer = createDraftExtensions({ entry: worker, directory: draft, origins: [], mirrors: () => '', locale: () => 'zh-cn', icon: () => '' })
  const host = new SharedExtensions(worker, path.join(directory, 'host'))
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'extensions/singer-metadata/manifest.json'), 'utf8'))
    const bundle = await readFile(path.join(root, 'extensions/singer-metadata/dist', `singer-metadata_v${manifest.version}.alix`))
    assert.equal((await installer.importPackage(bundle)).id, 'singer-metadata')
    const settings = path.join(draft, 'datas/singer-metadata')
    await mkdir(path.join(settings, 'storage'), { recursive: true })
    await writeFile(path.join(settings, 'storage', 'fixture.txt'), 'keep on update')
    await installer.call('disableExtension', ['singer-metadata'])
    assert.equal((await installer.importPackage(bundle)).enabled, false)
    assert.equal(await readFile(path.join(settings, 'storage', 'fixture.txt'), 'utf8'), 'keep on update')
    await installer.call('enableExtension', ['singer-metadata'])
    await installer.close()
    const release = path.join(directory, 'release')
    await snapshotExtensions(draft, release)
    const origins = JSON.parse(process.env.SINGER_TEST_ORIGINS ?? '[]') as string[]
    await host.switch('singer-only', release, origins, '')
    const resources = (await host.call('getResourceList', [])).value as AnyListen.Extension.ResourceList
    assert.equal(resources.resources.singerSearch?.length, 5)
    assert.equal(resources.resources.singer?.length, 5)
    await assert.rejects(host.call('resourceAction', ['singer', { extensionId: 'singer-metadata', source: 'invalid', id: '1', page: 1 }]))
    if (process.env.SINGER_LIVE === '1') {
      for (const source of ['wy', 'tx', 'kg', 'kw', 'mg']) {
        const params = { extensionId: 'singer-metadata', source, page: 1, limit: 2 }
        const search = (await host.call('resourceAction', ['singerSearch', { ...params, keyword: '周杰伦' }])).value as AnyListen.IPCExtension.ListCommonResult<AnyListen.Resource.SingerItem>
        const artist = search.list.find(s => s.name === '周杰伦')!
        assert(artist, source)
        const detail = (await host.call('resourceAction', ['singer', { ...params, id: artist.id }])).value as AnyListen.IPCExtension.SingerDetailResult
        assert.equal(detail.list.length, 2, source)
        console.log(`${source}: actual extension host search/detail passed`)
      }
    }
    const next = createDraftExtensions({ entry: worker, directory: draft, origins: [], mirrors: () => '', locale: () => 'zh-cn', icon: () => '' })
    try {
      await next.call('disableExtension', ['singer-metadata'])
      const disabled = path.join(directory, 'disabled')
      await snapshotExtensions(draft, disabled)
      await host.switch('disabled', disabled, [], '')
      assert.deepEqual(((await host.call('getResourceList', [])).value as AnyListen.Extension.ResourceList).resources, {})
      await next.call('uninstallExtension', ['singer-metadata'])
      const empty = path.join(directory, 'empty')
      await snapshotExtensions(draft, empty)
      await host.switch('empty', empty, [], '')
      assert.deepEqual(((await host.call('getResourceList', [])).value as AnyListen.Extension.ResourceList).resources, {})
    } finally { await next.close() }
  } finally {
    await installer.close()
    await host.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
