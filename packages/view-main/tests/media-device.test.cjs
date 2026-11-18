const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

const scriptsRequire = createRequire(path.resolve(__dirname, '../../shared/scripts/package.json'))
const source = readFileSync(path.resolve(__dirname, '../src/modules/player/store/mediaDevice.ts'), 'utf8')

test('media permission reports unavailable and denied requests and stops the successful probe', async () => {
  const { code } = scriptsRequire('esbuild').transformSync(source, {
    loader: 'ts', format: 'cjs', define: { 'import.meta.env.VITE_IS_WEB': 'true' },
  })
  const context = {
    module: { exports: {} },
    require: (name) => name === '@/plugins/i18n' ? { i18n: { t: (key) => key } } : {},
    navigator: {},
    location: { protocol: 'http:' },
    isSecureContext: false,
  }
  vm.runInNewContext(code, context)
  const { requestMediaDevicePermission, getHasMediaDevicePermission, setHasMediaDevicePermission } = context.module.exports

  setHasMediaDevicePermission(true)
  await assert.rejects(requestMediaDevicePermission(), /media_device\.httpNotAllowed/)
  assert.equal(getHasMediaDevicePermission(), false)
  context.isSecureContext = true
  context.location.protocol = 'https:'
  await assert.rejects(requestMediaDevicePermission(), /media_device\.notAvailable/)
  assert.equal(getHasMediaDevicePermission(), false)

  const deny = new DOMException('Permission denied', 'NotAllowedError')
  context.navigator.mediaDevices = { getUserMedia: async () => { throw deny } }
  await assert.rejects(requestMediaDevicePermission(), (error) => error === deny)
  assert.equal(getHasMediaDevicePermission(), false)

  let stopped = false
  context.navigator.mediaDevices.getUserMedia = async (options) => {
    assert.equal(options.audio, true)
    return { getTracks: () => [{ stop: () => { stopped = true } }] }
  }
  await requestMediaDevicePermission()
  assert.equal(getHasMediaDevicePermission(), true)
  assert.equal(stopped, true)
})
