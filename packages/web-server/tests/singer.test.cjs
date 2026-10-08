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

test('ordinary users may search singers and read works without gaining extension management access', async () => {
  const { protectRpc } = await load(`export { protectRpc } from './packages/web-server/src/accounts/managed'`)
  const rpc = protectRpc({ singerSearch: async () => 'search', singer: async () => 'works' }, {
    role: 'user', run: (action) => action(),
  })
  assert.equal(await rpc.singerSearch(), 'search')
  assert.equal(await rpc.singer(), 'works')
  await assert.rejects(rpc.installExtension(), /Forbidden/)
})

test('singer matching follows existing separators, counts duets once and excludes empty artists', async () => {
  const { splitSingers, filterSinger, getSingerOptions } = await load(`export * from './packages/shared/common/singers'`)
  assert.deepEqual(splitSingers('甲 / 乙;甲'), ['甲', '乙'])
  const list = [music('solo'), music('duet', '甲、乙'), music('other', '甲乙'), music('empty', '')]
  assert.deepEqual(
    filterSinger(list, '甲').map((m) => m.id),
    ['solo', 'duet']
  )
  assert.deepEqual(getSingerOptions(list), [
    { name: '甲', count: 2 },
    { name: '乙', count: 1 },
    { name: '甲乙', count: 1 },
  ])
  assert.equal(filterSinger(list, ''), list)
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

test('snapshot replaces old queue/history, loops, randomizes, restores and returns to full playlist', async () => {
  const statePath = './packages/view-main/src/modules/player/store/state'
  const commitPath = './packages/view-main/src/modules/player/store/commit'
  const api = await load(
    `
    export * from './packages/view-main/src/modules/player/store/playerActions'
    export { playerState } from '${statePath}'
    export { settingState } from '@/modules/setting/store/state'
  `,
    {
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
      export const setPlayListMusic = async (data) => { commit.setPlayListMusic(data.list); commit.setPlayListId(data.listId, data.source) }
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
