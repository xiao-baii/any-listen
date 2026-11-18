const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const { test } = require('node:test')
const { setImmediate: nextTurn } = require('node:timers/promises')
const vm = require('node:vm')

const { transformSync } = createRequire(path.resolve(__dirname, '../../shared/scripts/package.json'))('esbuild')
const ts = createRequire(path.resolve(__dirname, '../../shared/eslint/package.json'))('typescript')
const readSource = (file) => readFileSync(path.resolve(__dirname, '../src', file), 'utf8')
const LIST_IDS = { DEFAULT: 'default', LOVE: 'love', LAST_PLAYED: 'lastPlayed' }

function load(source, modules, globals = {}) {
  const module = { exports: {} }
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' })
  const context = Object.defineProperties(
    { module, require: (name) => modules[name] ?? {} },
    Object.getOwnPropertyDescriptors(globals)
  )
  vm.runInNewContext(code, context)
  return module.exports
}

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function viewFixture({ readPrevious = async () => null, tick = async () => {} } = {}) {
  const script = readSource('views/Library/index.svelte').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
  const parsed = ts.createSourceFile('Library.ts', script, ts.ScriptTarget.Latest, true)
  const effects = parsed.statements.filter((node) => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.expression.getText(parsed) === '$effect')
  const guard = parsed.statements.find((node) => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === 'isCurrentRoute'))
  const requests = [], replaces = [], saved = [], positions = []
  const connected = new Set()
  const listeners = new Map()
  const effectCallbacks = []
  const query = {}
  const userListExist = (id) => ['a', 'b', LIST_IDS.LOVE].includes(id)
  let location = '/'
  let browserLocation = { location, query: {} }
  let cleanups = []
  const readSongs = load([
    'let list = [], currentId = "", currentLocation = "", scrollReady = false, musicList = testList;',
    guard.getText(parsed),
    ...effects.map((node) => node.getText(parsed)),
    'module.exports = () => list;',
  ].join('\n'), {}, {
    $effect: (callback) => effectCallbacks.push(callback),
    $query: query,
    $userListInited: true,
    get $location() { return location },
    getLocation: () => browserLocation,
    get selectionExists() { return userListExist(query.id) },
    userListExist,
    LIST_IDS,
    untrack: (callback) => callback(),
    tick,
    testList: {
      setScrollPosition: (pos) => positions.push(pos),
      setScrollIndex: (index) => positions.push(index),
    },
    getListScrollPosition: async (id) => id === 'b' ? 20 : 10,
    getListMusics: (id) => {
      const request = deferred()
      requests.push({ id, resolve: (song) => request.resolve([{ id: song }]) })
      return request.promise
    },
    musicLibraryEvent: {
      on(name, callback) {
        listeners.set(name, callback)
        return () => listeners.delete(name)
      },
    },
    onConnected(callback) {
      connected.add(callback)
      return () => connected.delete(callback)
    },
    getListPrevSelectId: readPrevious,
    saveListPrevSelectId: async (id) => { saved.push(id) },
    replace: async (url) => { replaces.push(url) },
  })
  const unmount = () => { for (const cleanup of cleanups) cleanup?.() }
  return {
    navigate(id, mid, route = '/library') {
      unmount()
      location = route
      query.id = id
      query.mid = mid
      browserLocation = { location: route, query: { id, mid } }
      cleanups = effectCallbacks.map((callback) => callback())
    },
    changeHash(id) { browserLocation = { location: '/library', query: { id } } },
    unmount,
    requests, replaces, saved, positions,
    reconnect: () => { for (const callback of connected) callback() },
    emit: (name, value) => listeners.get(name)?.(value),
    songs: () => Array.from(readSongs(), (song) => song.id),
  }
}

test('rapid list changes and event refreshes discard outdated music and scroll responses', async () => {
  const view = viewFixture()
  view.navigate('a', 'original')
  view.navigate('b')
  view.requests[1].resolve('b-song')
  await nextTurn()
  view.requests[0].resolve('original')
  await nextTurn()
  assert.deepEqual(view.songs(), ['b-song'])
  assert.deepEqual(view.positions, [20])
  assert.deepEqual(view.replaces, [])

  view.navigate('a')
  view.navigate('b')
  view.navigate('a')
  view.requests[2].resolve('stale-a')
  view.requests[3].resolve('stale-b')
  await nextTurn()
  assert.deepEqual(view.songs(), [])
  view.requests[4].resolve('fresh-a')
  await nextTurn()
  assert.deepEqual(view.songs(), ['fresh-a'])

  view.emit('listMusicChanged', ['a'])
  view.emit('listMusicUpdated', new Set(['a']))
  view.requests[6].resolve('latest-event')
  await nextTurn()
  view.requests[5].resolve('old-event')
  await nextTurn()
  assert.deepEqual(view.songs(), ['latest-event'])
})

test('leaving after songs load invalidates the pending scroll and route update', async () => {
  const render = deferred()
  const view = viewFixture({ tick: () => render.promise })
  view.navigate('a', 'anchor')
  view.requests[0].resolve('anchor')
  await nextTurn()
  view.unmount()
  render.resolve()
  await nextTurn()
  assert.deepEqual(view.positions, [])
  assert.deepEqual(view.replaces, [])
})

test('startup restoration respects the selected list and retries it on reconnect', async () => {
  const previous = deferred()
  const view = viewFixture({ readPrevious: () => previous.promise })
  view.navigate(undefined, undefined, '/')
  view.changeHash('b')
  previous.resolve('a')
  await nextTurn()
  assert.deepEqual(view.replaces, [])
  view.navigate('b')
  assert.deepEqual(view.saved, ['b'])
  view.reconnect()
  assert.deepEqual(view.saved, ['b', 'b'])
})

test('a failed restore on the startup route falls back to Favorites', async () => {
  const view = viewFixture({ readPrevious: async () => { throw new Error('offline') } })
  view.navigate(undefined, undefined, '/')
  await nextTurn()
  assert.deepEqual(view.replaces, ['/library?id=love'])
})

test('removing a parent clears nested and duplicate IDs and rejects late cache updates', async () => {
  const folder = { id: 'folder', parentId: null }
  const child = { id: 'child', parentId: 'folder' }
  const grandchild = { id: 'grandchild', parentId: 'child' }
  const remaining = { id: 'remaining', parentId: null }
  const state = {
    userLists: [folder, child, grandchild, remaining],
    userListsMap: new Map([[null, [folder, remaining]], ['folder', [child]], ['child', [grandchild]]]),
    allMusicList: new Map([[folder.id, []], [child.id, []], [grandchild.id, []]]),
  }
  const changes = []
  const commit = load(readSource('modules/musicLibrary/store/commit.ts'), {
    '@any-listen/common/constants': { LIST_IDS },
    './state': { musicLibraryState: state },
    './event': { musicLibraryEvent: { listSubListChanged() {}, listMusicChanged: (ids) => changes.push(Array.from(ids)) } },
  })
  const remote = deferred()
  const { getListMusics } = load(readSource('modules/musicLibrary/store/actions.ts'), {
    '@/shared': { throttle: (action) => action },
    './state': { musicLibraryState: state },
    './commit': commit,
    './listRemoteActions': { getListMusics: () => remote.promise },
  })
  const loading = getListMusics(child.id, true)
  commit.userListsRemove([folder.id, child.id])
  remote.resolve([{ id: 'late' }])
  await loading
  assert.deepEqual(state.userLists, [remaining])
  assert.deepEqual([...state.userListsMap], [[null, [remaining]]])
  assert.deepEqual([...state.allMusicList], [])
  assert.deepEqual(changes, [['folder', 'child', 'grandchild']])
})

test('selection saves serialize, retry failed IDs and reset on reconnect', async () => {
  const writes = []
  let reconnect
  const { saveListPrevSelectId: save } = load(readSource('shared/ipc/list/index.ts'), {
    '@/modules/app/shared': { onConnected: (callback) => { reconnect = callback } },
    '../ipc': { ipc: { saveListPrevSelectId(id) {
      const completion = deferred()
      writes.push({ id, ...completion })
      return completion.promise
    } } },
  })
  const ids = () => writes.map((item) => item.id)
  const first = assert.rejects(save('a'), /offline/)
  const retry = save('a')
  await nextTurn()
  assert.deepEqual(ids(), ['a'])
  writes[0].reject(new Error('offline'))
  await first
  await nextTurn()
  assert.deepEqual(ids(), ['a', 'a'])
  writes[1].resolve()
  await retry
  await save('a')

  const old = save('b')
  const oldQueued = save('c')
  await nextTurn()
  reconnect()
  const current = save('d')
  await nextTurn()
  assert.deepEqual(ids(), ['a', 'a', 'b', 'd'])
  writes[3].resolve()
  await current
  writes[2].resolve()
  await Promise.all([old, oldQueued])
  await save('d')
  assert.deepEqual(ids(), ['a', 'a', 'b', 'd'])
})
