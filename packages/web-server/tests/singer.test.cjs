const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createRequire } = require('node:module')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '../../..')
const scriptsRequire = createRequire(path.join(root, 'packages/shared/scripts/package.json'))

async function load(contents, mocks = {}) {
  const { outputFiles } = await scriptsRequire('esbuild').build({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    define: { 'import.meta.env.VITE_IS_WINDOWS_LEGACY': 'false' },
    tsconfig: path.join(root, 'packages/view-main/tsconfig.json'),
    plugins: [
      {
        name: 'test-boundaries',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (Object.hasOwn(mocks, args.path)) return { path: args.path, namespace: 'mock' }
          })
          build.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
            contents: mocks[args.path],
            loader: 'ts',
            resolveDir: root,
          }))
        },
      },
    ],
  })
  const module = { exports: {} }
  vm.runInThisContext(`(function(require,module,exports){${outputFiles[0].text}\n})`)(scriptsRequire, module, module.exports)
  return module.exports
}

const music = (id, singer = '甲') => ({
  id,
  name: id,
  singer,
  interval: null,
  isLocal: false,
  meta: { source: 'fixture', musicId: id, qualitys: {} },
})

test('singer navigation carries only the name and current or last online source', async () => {
  const api = await load(`
    export { toSingerSearch, setLastHistory } from './packages/view-main/src/modules/resource/actions'
    export { location, calls } from '@/plugins/routes'
  `, {
    '@/plugins/routes': `
      export const location = { location: '/library', query: {} }
      export const calls = []
      export const getLocation = () => location
      export const push = (path, params) => calls.push({ path, params })
      export const replace = () => {}
    `,
    '@/views/Online/shared.svelte': `export const urlParamKeyMap = { type: 't', query: 'q' }`,
  })
  const name = '陈奕迅 & Eason'
  api.toSingerSearch(name)
  assert.deepEqual(api.calls.pop(), { path: '/online', params: { t: 'search', qt: 'singer', q: name, s: undefined } })

  api.setLastHistory('/online/topSongs', { sid: 'extension_rank', s: 'raw-platform', id: 'old', p: 3 })
  api.toSingerSearch(name)
  assert.equal(api.calls.pop().params.s, 'extension_rank')

  api.location.location = '/online'
  api.location.query = { t: 'songlist', s: 'extension_current', q: 'old', id: 'old', p: 5 }
  api.toSingerSearch(name)
  assert.deepEqual(api.calls.pop(), { path: '/online', params: { t: 'search', qt: 'singer', q: name, s: 'extension_current' } })

  api.location.location = '/online/songlist'
  api.location.query = { sid: 'extension_detail', s: 'raw-platform', id: 'old' }
  api.toSingerSearch(name)
  assert.equal(api.calls.pop().params.s, 'extension_detail')

  api.location.location = '/library'
  api.toSingerSearch(name)
  assert.equal(api.calls.pop().params.s, 'extension_detail')
})

test('batch queue removal keeps remaining order and emits the existing events', async () => {
  const api = await load(`
    export { removePlayListMusic } from './packages/view-main/src/modules/player/store/commit'
    export { playerState } from './packages/view-main/src/modules/player/store/state'
    export { playerEvent } from './packages/view-main/src/modules/player/store/event'
  `)
  api.playerState.playList = ['a', 'b', 'c', 'd'].map(itemId => ({ itemId, musicInfo: music(itemId) }))
  const events = []
  for (const event of ['playListMusicRemoved', 'playListMusicChanged', 'playListChanged'])
    api.playerEvent.on(event, value => events.push([event, value]))
  const ids = ['b', 'missing', 'b', 'd']
  api.removePlayListMusic(ids)
  await Promise.resolve()
  assert.deepEqual(api.playerState.playList.map(item => item.itemId), ['a', 'c'])
  assert.deepEqual(events.map(([event]) => event), ['playListMusicRemoved', 'playListMusicChanged', 'playListChanged'])
  assert.deepEqual(events[0][1], ids)
  assert.deepEqual(events[1][1].map(item => item.itemId), ['a', 'c'])
})

test('ordinary users may search singers and read works without gaining extension management access', async () => {
  const { protectRpc } = await load(`export { protectRpc } from './packages/web-server/src/accounts/managed'`)
  const rpc = protectRpc({ singerSearch: async () => 'search', singer: async () => 'works' }, {
    role: 'user', run: (action) => action(),
  })
  assert.equal(await rpc.singerSearch(), 'search')
  assert.equal(await rpc.singer(), 'works')
  await assert.rejects(rpc.installExtension(), /Forbidden/)
})

test('singer search matches names partially, ignores case and whitespace, and preserves song order', async () => {
  const { splitSingers, filterSinger } = await load(`export * from './packages/shared/common/singers'`)
  assert.deepEqual(splitSingers('甲 / 乙;甲'), ['甲', '乙'])
  const list = [music('solo'), music('duet', '甲、乙'), music('other', '甲乙'), music('empty', '')]
  assert.deepEqual(
    filterSinger(list, '甲').map((m) => m.id),
    ['solo', 'duet', 'other']
  )
  assert.deepEqual(filterSinger(list, '乙').map((m) => m.id), ['duet', 'other'])
  assert.deepEqual(filterSinger(list, '不存在'), [])
  const english = [music('solo', 'Adele'), music('duet', 'Adele / Someone'), { ...music('title', 'Other'), name: 'Adele' }]
  assert.deepEqual(filterSinger(english, '  ADE  ').map((m) => m.id), ['solo', 'duet'])
  assert.equal(filterSinger(list, ''), list)
  assert.equal(filterSinger(list, '   '), list)
})

test('test extension supplies singer search and works through SDK validation and the resource service', async () => {
  const { registerResourceAction, onResourceAction, createSingers } = await load(
    `
    export * from './packages/shared/extension-preload/src/apis/resource'
    export { createSingers } from './packages/shared/app/modules/resources/singer'
  `,
    { './global': 'export const console = globalThis.console', './shared': 'export const services = {}' }
  )
  const artist = { id: 'artist', name: '甲', img: 'https://example.com/artist.jpg' }
  registerResourceAction({
    singerSearch: async ({ keyword, page }) => {
      if (keyword === 'fail') throw Error('fixture failure')
      return { list: keyword === 'empty' ? [] : [artist], total: keyword === 'empty' ? 0 : 2, page, limit: 1 }
    },
    singer: async ({ id, page }) => {
      if (id === 'invalid-page') return { list: [], total: 1, page, limit: 0, info: artist }
      if (id === 'invalid') return { list: [], total: 1, page, limit: 1, info: { name: 'missing id' } }
      return { list: [music('song-' + page)], total: 2, page, limit: 1, info: artist }
    },
  })
  const service = createSingers({ extensionSerive: { resourceAction: onResourceAction } })
  const params = { extensionId: 'fixture', source: 'fixture', page: 1 }
  assert.deepEqual((await service.singerSearch({ ...params, keyword: '甲' })).list, [artist])
  assert.equal((await service.singerSearch({ ...params, keyword: 'empty' })).total, 0)
  assert.equal((await service.singer({ ...params, id: 'artist', page: 2 })).list[0].id, 'song-2')
  await assert.rejects(service.singerSearch({ ...params, keyword: 'fail' }), /fixture failure/)
  await assert.rejects(service.singer({ ...params, id: 'invalid' }), /singer id/)
  await assert.rejects(service.singer({ ...params, id: 'invalid-page' }), /Invalid singer pagination/)
  registerResourceAction({ musicSearch: async () => ({ list: [], total: 0, page: 1, limit: 30 }) })
  assert.equal((await onResourceAction('musicSearch', { ...params, name: 'old source' })).total, 0)
  await assert.rejects(service.singerSearch({ ...params, keyword: '甲' }), /not registered/)
})

test('full singer works load follows provider pagination, deduplicates, and propagates failure', async () => {
  const { getSingerMusics, calls } = await load(
    `
    export * from './packages/view-main/src/modules/resource/singer'
    export { calls } from '@/shared/ipc/resource'
  `,
    {
      '@/shared/ipc/resource': `
    export const calls = []
    export async function singer(params) {
      calls.push(params)
      if (params.id === 'fail' && params.page === 2) throw Error('page failed')
      return { list: [{ id: 'song-' + params.page }, { id: 'shared' }], total: 4, limit: 2, page: params.page }
    }
  `,
    }
  )
  assert.deepEqual(
    (await getSingerMusics('ext', 'source', 'artist')).map((m) => m.id),
    ['song-1', 'shared', 'song-2']
  )
  assert.deepEqual(
    calls.map((p) => [p.page, p.limit]),
    [
      [1, 10000],
      [2, 2],
    ]
  )
  await assert.rejects(getSingerMusics('ext', 'source', 'fail'), /page failed/)
})

async function loadPlayer() {
  const statePath = './packages/view-main/src/modules/player/store/state'
  const commitPath = './packages/view-main/src/modules/player/store/commit'
  return load(
    `
    export * from './packages/view-main/src/modules/player/store/playerActions'
    export { playerState } from '${statePath}'
    export { resource } from '@/shared/ipc/resource'
    export { prefetchSingerQueue } from './packages/view-main/src/modules/player/store/playerActions'
    export { notices } from '@/components/apis/notify'
    export { settingState } from '@/modules/setting/store/state'
  `,
    {
      '@/shared/ipc/player/event': 'export const playListActionEvent = { on: () => () => {} }',
      '@/components/apis/notify': 'export const notices = []; export const showNotify = text => notices.push(text)',
      '@/shared/ipc/resource': `
        export const resource = { calls: [], run: async () => { throw new Error('unexpected fetch') } }
        export const singer = async data => { resource.calls.push(data); return resource.run(data) }
      `,
      '@/shared/ipc/player': `
        import { playerState } from '${statePath}'
        import { applySingerPage } from './listRemoteAction'
        export const getPlayInfo = async () => ({ list: playerState.playList, listId: null, source: 'singer', singerQueue: playerState.singerQueue })
        export const sendPlayListAction = async ({ data }) => {
          const ids = new Set(playerState.playList.filter(item => !item.playLater).map(item => item.musicInfo.id))
          const accepted = { ...data, musics: data.musics.filter(item => !ids.has(item.musicInfo.id)) }
          applySingerPage(accepted)
          return accepted
        }
      `,
      '@any-listen/web': 'export const checkPicUrl = async () => {}',
      '@/modules/command/actions': 'export const executeLocalCommand = () => {}',
      '@/modules/app/store/state': 'export const appState = {}',
      '@/modules/dislikeList/actions': 'export const addInfo = async () => {}',
      '@/modules/musicLibrary/store/actions':
        'export const getListMusics = async () => []; export const addListMusics = async () => {}; export const removeListMusics = async () => {}; export const parseMusicMetadata = async () => {}; export const updateListMusic = async () => {};',
      '@/modules/resource/songlist/detail/actions': 'export const songlistDetailAll = async () => []',
      '@/modules/resource/topSongs/detail/actions': 'export const topSongsDetailAll = async () => []',
      '@/modules/setting/store/state': `export const settingState = { setting: { 'player.togglePlayMethod': 'listLoop' } }`,
      '@/plugins/i18n': 'export const i18n = { t: (text) => text }',
      '@/plugins/player':
        'export const getSrc = () => ""; export const isEmpty = () => false; export const releasePlayer = async () => {}; export const setPause = () => {}; export const setPlay = () => {}; export const setResource = () => {}; export const setStop = () => {};',
      '@/shared': 'export { getRandom } from "./packages/shared/common/utils"; export const parseInterval = () => 0;',
      './listRemoteAction': `
      import * as commit from '${commitPath}'
      import { playerState } from '${statePath}'
      export { applySingerPage } from './packages/view-main/src/modules/player/store/listRemoteAction'
      export const setPlayListMusic = async (data) => { playerState.singerQueue = data.singerQueue; commit.setPlayListMusic(data.list); commit.setPlayListId(data.listId, data.source) }
      export const setPlayListMusicPlayed = async (ids) => commit.updatePlayListMusicPlayed(true, ids)
      export const setPlayListMusicUnplayedAll = async () => commit.updatePlayListMusicPlayedAll(false)
    `,
      './playerRemoteAction': `
      import { playerState } from '${statePath}'
      export const setPlayHistoryList = async (list) => { playerState.playHistoryList = list }
      export const addPlayHistoryList = async (list) => { playerState.playHistoryList.push(...list) }
      export const getMusicLyric = async () => ({ info: { lyric: '' } })
      export const getMusicPic = async () => ({ url: '' })
      export const getMusicUrl = async () => ({ url: '' })
    `,
    }
  )
}

test('snapshot replaces old queue/history, loops, randomizes, restores and returns to full playlist', async () => {
  const api = await loadPlayer()
  const { playerState: state, settingState: settings } = api
  const list = [music('a'), music('b'), music('c', '乙')]
  await api.playList('original', list, 0)
  settings.setting['player.togglePlayMethod'] = 'random'
  await api.getNextPlayMusicInfo()
  state.playHistoryList.push({ id: 'old', time: 0 })
  state.playList.push({ ...state.playList[2], playLater: true, itemId: 'later' })
  await api.playMusicCollection('original', list.slice(0, 2), 0, 'local')
  assert.equal(state.playInfo.listId, null)
  assert.equal(state.playInfo.isLinkedList, false)
  assert.deepEqual(
    state.playList.map((m) => m.musicInfo.id),
    ['a', 'b']
  )
  assert.equal(state.playList[0].listId, 'original')
  assert.equal(state.playHistoryList.length, 0)
  await api.skipNext()
  assert.ok(state.playList.some((item) => item.itemId === state.playMusicInfo.itemId), 'must discard prefetched music from the old queue')
  settings.setting['player.togglePlayMethod'] = 'listLoop'
  await api.playMusicCollection('original', list.slice(0, 2), 0, 'local')
  await api.skipNext(true)
  assert.equal(state.playMusicInfo.musicInfo.id, 'b')
  await api.skipNext(true)
  assert.equal(state.playMusicInfo.musicInfo.id, 'a')
  await api.skipPrev()
  assert.equal(state.playMusicInfo.musicInfo.id, 'b')
  settings.setting['player.togglePlayMethod'] = 'random'
  await api.playMusicCollection('original', list.slice(0, 2), 0, 'local')
  await api.skipNext()
  assert.equal(state.playMusicInfo.musicInfo.id, 'b')
  await api.skipPrev()
  assert.equal(state.playMusicInfo.musicInfo.id, 'a')
  const saved = JSON.parse(JSON.stringify({ list: state.playList, info: state.playInfo, current: state.playMusicInfo }))
  state.playList = saved.list
  state.playInfo = saved.info
  state.playMusicInfo = saved.current
  settings.setting['player.togglePlayMethod'] = 'listLoop'
  await api.skipNext(true)
  assert.equal(state.playMusicInfo.musicInfo.id, 'b')
  await api.playMusicCollection('original', [list[2]], 0, 'local')
  await api.skipNext(true)
  assert.equal(state.playMusicInfo.musicInfo.id, 'c')
  await api.playList('original', list, 0)
  assert.equal(state.playInfo.isLinkedList, true)
  assert.equal(state.playList.length, 3)
})

const queue = (id = 'queue', page = 1) => ({ queueId: id, extensionId: 'ext', source: 'fixture', singerId: 'artist', startPage: page, nextPage: page + 1, limit: 2, ended: false })
const page = (list, number, total = 6) => ({ list, page: number, limit: 2, total, info: { id: 'artist', name: 'Artist' } })

test('clicked page needs no fetch; sequential prepares only page one and random still loads all', async () => {
  const api = await load(`
    export { prepareSingerPlayback } from './packages/view-main/src/modules/resource/singer'
    export { calls } from '@/shared/ipc/resource'
  `, { '@/shared/ipc/resource': `
    export const calls = []
    export const singer = async data => {
      calls.push(data.page)
      return { page: data.page, limit: 2, total: 4, list: [{ id: String(data.page) }] }
    }
  ` })
  const current = page([music('c'), music('d')], 2)
  const clicked = await api.prepareSingerPlayback('ext', 'fixture', 'artist', current, 'd')
  assert.equal(clicked.index, 1)
  assert.equal(clicked.singerQueue.nextPage, 3)
  assert.deepEqual(api.calls, [])
  await api.prepareSingerPlayback('ext', 'fixture', 'artist', current, '', false)
  assert.deepEqual(api.calls, [1])
  const random = await api.prepareSingerPlayback('ext', 'fixture', 'artist', current, '', true)
  assert.equal(random.singerQueue, undefined)
  assert.deepEqual(api.calls, [1, 1, 2])
})

test('boundary shares prefetch, continues across pages, deduplicates, and loops only at the end', async () => {
  const api = await loadPlayer()
  let resolve
  api.resource.run = () => new Promise(r => { resolve = r })
  await api.playMusicCollection('artist', [music('c'), music('d')], 1, 'singer', queue('one', 2))
  const preload = api.prefetchSingerQueue()
  const next = api.skipNext(true)
  assert.equal(api.resource.calls.length, 1)
  assert.equal(api.playerState.playMusicInfo.musicInfo.id, 'd')
  resolve(page([music('d'), music('e')], 3))
  await Promise.all([preload, next])
  assert.deepEqual(api.playerState.playList.map(item => item.musicInfo.id), ['c', 'd', 'e'])
  assert.equal(api.playerState.playMusicInfo.musicInfo.id, 'e')
  await api.skipNext(true)
  assert.equal(api.playerState.playMusicInfo.musicInfo.id, 'c')
})

test('failed page preserves queue, does not automatically retry, and manual next retries', async () => {
  const api = await loadPlayer()
  await api.playMusicCollection('artist', [music('a')], 0, 'singer', queue())
  api.resource.run = async () => { throw new Error('page failed') }
  await assert.rejects(api.prefetchSingerQueue(), /page failed/)
  await api.skipNext(true)
  assert.equal(api.resource.calls.length, 1)
  assert.equal(api.playerState.playMusicInfo.musicInfo.id, 'a')
  assert.equal(api.playerState.singerQueue.nextPage, 2)
  api.resource.run = async () => page([music('b')], 2, 3)
  await api.skipNext()
  assert.equal(api.resource.calls.length, 2)
  assert.equal(api.playerState.playMusicInfo.musicInfo.id, 'b')
  assert.equal(api.playerState.playing, true)
})

test('random completes earlier pages before selection without replacing current item or progress', async () => {
  const api = await loadPlayer()
  await api.playMusicCollection('artist', [music('c')], 0, 'singer', { ...queue('random', 2), ended: true })
  api.settingState.setting['player.togglePlayMethod'] = 'random'
  const current = api.playerState.playMusicInfo
  api.playerState.progress.nowPlayTime = 42
  api.resource.run = async data => page(data.page === 1 ? [music('a'), music('b')] : [music('c')], data.page, 3)
  await api.prefetchSingerQueue()
  assert.equal(api.playerState.playMusicInfo, current)
  assert.equal(api.playerState.progress.nowPlayTime, 42)
  assert.deepEqual(api.playerState.playList.map(item => item.musicInfo.id), ['c', 'a', 'b'])
  assert.equal(api.playerState.singerQueue.startPage, 1)
  assert.ok(['a', 'b'].includes((await api.getNextPlayMusicInfo()).musicInfo.id))
})

test('old page completion cannot append or advance playback after a replacement', async () => {
  const api = await loadPlayer()
  let resolve
  api.resource.run = () => new Promise(r => { resolve = r })
  await api.playMusicCollection('old', [music('a')], 0, 'singer', queue())
  const pending = api.skipNext(true)
  await api.playMusicCollection('new', [music('x')], 0, 'singer', queue('new'))
  resolve(page([music('b')], 2, 3))
  await pending
  assert.deepEqual(api.playerState.playList.map(item => item.musicInfo.id), ['x'])
  assert.equal(api.playerState.playMusicInfo.musicInfo.id, 'x')
})


test('empty terminal page ends pagination and permits looping; restored state can continue', async () => {
  const api = await loadPlayer()
  await api.playMusicCollection('artist', [music('a')], 0, 'singer', queue())
  api.playerState.singerQueue = JSON.parse(JSON.stringify(api.playerState.singerQueue))
  api.resource.run = async data => page([], data.page, 20)
  await api.skipNext()
  assert.equal(api.playerState.singerQueue.ended, true)
  assert.equal(api.playerState.playMusicInfo.musicInfo.id, 'a')
  await api.skipNext()
  assert.equal(api.resource.calls.length, 1)
})

test('failed full preparation never selects a partial random queue; play-later remains first', async () => {
  const api = await loadPlayer()
  await api.playMusicCollection('artist', [music('a'), music('b')], 0, 'singer', queue())
  api.settingState.setting['player.togglePlayMethod'] = 'random'
  api.resource.run = async () => { throw new Error('full failed') }
  await api.skipNext()
  assert.equal(api.playerState.playMusicInfo.musicInfo.id, 'a')
  assert.deepEqual(api.notices, ['full failed'])
  const calls = api.resource.calls.length
  api.playerState.playList.push({ ...api.playerState.playList[1], itemId: 'later', playLater: true })
  await api.skipNext()
  assert.equal(api.playerState.playMusicInfo.itemId, 'later')
  assert.equal(api.resource.calls.length, calls)
})
