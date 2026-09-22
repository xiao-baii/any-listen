const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')
const scriptsRequire = createRequire(path.resolve(__dirname, '../../shared/scripts/package.json'))
const source = readFileSync(path.resolve(__dirname, '../src/accounts/state.svelte.ts'), 'utf8')

test('local storage preserves device keys and isolates accounts', () => {
  const source = readFileSync(path.resolve(__dirname, '../src/shared/localStore.ts'), 'utf8')
  const values = new Map()
  for (const web of [true, false]) {
    const { code } = scriptsRequire('esbuild').transformSync(source, {
      loader: 'ts', format: 'cjs', define: { 'import.meta.env.VITE_IS_WEB': String(web) },
    })
    const context = {
      module: { exports: {} }, location: { pathname: '/' },
      localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    }
    vm.runInNewContext(code, context)
    const storage = context.module.exports
    storage.setItem('media_device_id', 'default-device')
    context.location.pathname = '/u/alice/'
    storage.setItem('media_device_id', 'alice-device')
    context.location.pathname = '/u/bob/'
    assert.equal(storage.getItem('media_device_id'), web ? null : 'alice-device')
    context.location.pathname = '/u/alice/'
    assert.equal(storage.getItem('media_device_id'), 'alice-device')
    assert.equal(values.get('media_device_id'), web ? 'default-device' : 'alice-device')
    values.clear()
  }
})

test('account entry redirects authenticated visitors without interrupting internal routes', async () => {
  for (const scenario of [
    { pathname: '/', user: { id: 'alice' }, redirect: '/u/alice/' },
    { pathname: '/u/bob/', user: { id: 'alice' }, redirect: '/u/alice/' },
    { pathname: '/u/alice/', user: { id: 'alice' } },
    { pathname: '/', user: null },
    { pathname: '/', status: 404 },
    { pathname: '/', desktop: true },
  ]) {
    const { code } = scriptsRequire('esbuild').transformSync(source, {
      loader: 'ts', format: 'cjs',
      define: { 'import.meta.env.VITE_IS_WEB': String(!scenario.desktop) },
    })
    const redirects = []
    const context = {
      module: { exports: {} },
      $state: (value) => value,
      location: { pathname: scenario.pathname, replace: (url) => redirects.push(url) },
      document: { documentElement: { classList: { add() {} } } },
      fetch: async () => ({
        status: scenario.status ?? (scenario.user ? 200 : 401),
        ok: Boolean(scenario.user),
        headers: { get: () => 'application/json' },
        json: async () => ({ user: scenario.user }),
      }),
    }
    vm.runInNewContext(code, context)
    await context.module.exports.initAccount()
    assert.deepEqual(redirects, scenario.redirect ? [scenario.redirect] : [], scenario.pathname)
    assert.equal(context.module.exports.account.ready, !scenario.redirect)
  }
})
