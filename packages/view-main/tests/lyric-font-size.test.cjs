const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const scriptsRequire = createRequire(path.resolve(__dirname, '../../shared/scripts/package.json'))
const source = readFileSync(path.resolve(__dirname, '../src/modules/setting/store/action.ts'), 'utf8')

test('web lyric size stays local across updates and reconnects; desktop still syncs', async () => {
  for (const web of [true, false]) {
    let stored = null
    let remoteSize = 120
    let onChanged
    const sent = []
    const state = {}
    const { code } = scriptsRequire('esbuild').transformSync(source, {
      loader: 'ts', format: 'cjs', define: { 'import.meta.env.VITE_IS_WEB': String(web) },
    })
    const modules = {
      '@/modules/app/store/action': { setSetting: async value => sent.push(value) },
      '@/shared/ipc/app': { getSetting: async () => ({ 'playDetail.style.fontSize': remoteSize }) },
      '@/shared/ipc/app/event': { settingChangedEvent: { on: callback => { onChanged = callback } } },
      '@/shared/localStore': {
        LOCAL_STORE_KEYS: { lyricFontSize: 'lyric_font_size' },
        getItem: () => stored,
        setItem: (_key, value) => { stored = value },
      },
      './commit': { updateSetting: (_keys, value) => Object.assign(state, value) },
    }
    const context = { module: { exports: {} }, require: name => modules[name] }
    vm.runInNewContext(code, context)
    const actions = context.module.exports
    assert.equal((await actions.getSetting())['playDetail.style.fontSize'], 120)
    assert.equal(stored, web ? '120' : null)
    await actions.updateSetting({ 'playDetail.style.fontSize': 150 })
    assert.equal(sent.length, web ? 0 : 1)
    assert.equal(stored, web ? '150' : null)
    await actions.updateSetting({ 'playDetail.style.fontSize': 160, 'playDetail.style.align': 'left' })
    assert.equal(sent.at(-1)['playDetail.style.align'], 'left')
    assert.equal(sent.at(-1)['playDetail.style.fontSize'], web ? undefined : 160)
    actions.registerRemoteSettingAction()
    onChanged(['playDetail.style.fontSize', 'playDetail.style.align'], {
      'playDetail.style.fontSize': 80, 'playDetail.style.align': 'right',
    })
    assert.equal(state['playDetail.style.fontSize'], web ? 160 : 80)
    assert.equal(state['playDetail.style.align'], 'right')
    remoteSize = 80
    assert.equal((await actions.getSetting())['playDetail.style.fontSize'], web ? 160 : 80)
    await actions.updateSetting({ 'playDetail.style.fontSize': 100 })
    assert.equal(stored, web ? '100' : null)
    if (web) {
      for (const invalid of ['broken', '0', '201']) {
        stored = invalid
        assert.equal((await actions.getSetting())['playDetail.style.fontSize'], 80)
        assert.equal(stored, '80')
      }
    }
  }
})
