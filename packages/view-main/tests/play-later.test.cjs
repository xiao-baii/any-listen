const assert = require('node:assert/strict')
const { test } = require('node:test')
const { setImmediate: nextTurn } = require('node:timers/promises')
const { deferred, load, parseScript, readSource, ts } = require('./helpers.cjs')

function queueFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const onAdded = new Set()
  const onDisconnected = new Set()
  const pendingTimers = new Set()
  const requests = []
  let nextId = 0
  const playerState = { playList: [{ playLater: true }, { playLater: false }] }
  const { addPlayLaterMusic } = load(readSource('modules/player/store/actions.ts'), {
    '@any-listen/common/tools': {
      createPlayMusicInfoList: ({ musicInfos }) => musicInfos.map(() => ({ itemId: String(nextId++) })),
    },
    '@/modules/app/shared': {
      onDesconnected(callback) {
        onDisconnected.add(callback)
        return () => onDisconnected.delete(callback)
      },
    },
    '@/plugins/i18n': { i18n: { t: (key) => key } },
    './state': { playerState },
    './event': {
      playerEvent: {
        on(name, callback) {
          assert.equal(name, 'playListMusicAdded')
          onAdded.add(callback)
          return () => onAdded.delete(callback)
        },
      },
    },
    './listRemoteAction': {
      addPlayListMusic(data) {
        const rpc = deferred()
        requests.push({ data, ...rpc })
        return rpc.promise
      },
    },
  }, {
    setTimeout(callback, delay) {
      const timer = setTimeout(callback, delay)
      pendingTimers.add(timer)
      return timer
    },
    clearTimeout(timer) {
      pendingTimers.delete(timer)
      clearTimeout(timer)
    },
  })
  return {
    addPlayLaterMusic,
    requests,
    emitAdded(items) {
      for (const notify of onAdded) notify(0, items)
    },
    disconnect() {
      for (const notify of onDisconnected) notify()
    },
    assertClean() {
      assert.equal(onAdded.size, 0)
      assert.equal(onDisconnected.size, 0)
      assert.equal(pendingTimers.size, 0)
    },
  }
}

test('waits for the full ordered item IDs from the local queue', async (t) => {
  const queue = queueFixture(t)
  let completed = false
  const added = queue.addPlayLaterMusic([{}, {}], 'list').then(() => { completed = true })
  const request = queue.requests[0]
  assert.equal(request.data.pos, 1)
  const [first, second] = request.data.musics
  const other = { itemId: 'another request' }
  request.resolve()
  for (const unrelated of [[], [first], [first, second, other], [second, first], [first, other]]) {
    queue.emitAdded(unrelated)
  }
  await nextTurn()
  assert.equal(completed, false)
  queue.emitAdded([first, second])
  await added
  await queue.addPlayLaterMusic([], 'list')
  assert.equal(queue.requests.length, 1)
  queue.assertClean()
})

test('rejects failed queue RPCs and ignores their later events', async (t) => {
  const queue = queueFixture(t)
  const added = queue.addPlayLaterMusic([{}], 'list')
  const request = queue.requests[0]
  const error = new Error('queue write failed')
  request.reject(error)
  await assert.rejects(added, error)
  queue.emitAdded(request.data.musics)
  queue.assertClean()
})

test('ends play later on disconnect even if the RPC is pending', async (t) => {
  const queue = queueFixture(t)
  const added = queue.addPlayLaterMusic([{}], 'list')
  queue.disconnect()
  await assert.rejects(added, /play_later_disconnected/)
  queue.requests[0].reject(new Error('late RPC rejection'))
  queue.assertClean()
})

test('ends unconfirmed play later at 30 seconds without submitting again', async (t) => {
  const queue = queueFixture(t)
  let completed = false
  const added = queue.addPlayLaterMusic([{}], 'list').finally(() => { completed = true })
  t.mock.timers.tick(29_999)
  await nextTurn()
  assert.equal(completed, false)
  t.mock.timers.tick(1)
  await assert.rejects(added, /play_later_unconfirmed/)
  queue.emitAdded(queue.requests[0].data.musics)
  assert.equal(queue.requests.length, 1)
  queue.assertClean()
})

test('the list menu keeps selections on failure and clears them after confirmation', async () => {
  const notices = []
  const selected = [{ id: 'a' }, { id: 'b' }]
  let confirmation = deferred()
  let clears = 0
  const { playMusicLater } = load(readSource('components/common/MusicList/List/action.ts'), {
    '@/components/apis/notify': { showNotify: (message) => notices.push(message) },
    '@/modules/player/store/actions': {
      addPlayLaterMusic(tracks) {
        assert.equal(tracks, selected)
        return confirmation.promise
      },
    },
  }, { Error })
  const playLater = () => playMusicLater('list', selected[0], selected, 'local', () => { clears++ })
  const rejected = playLater()
  confirmation.reject(new Error('queue write failed'))
  await rejected
  assert.deepEqual(notices, ['queue write failed'])
  assert.equal(clears, 0)
  confirmation = deferred()
  const accepted = playLater()
  assert.equal(clears, 0)
  confirmation.resolve()
  await accepted
  assert.equal(clears, 1)
})

test('changing source advances playback only after the replacement joins the queue', async () => {
  const parsed = parseScript('components/common/MusicList/List/components/MusicToggleModal/MusicToggleModal.svelte')
  const handler = parsed.statements.find((node) => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === 'handlePlay'))
  const calls = []
  const music = { id: 'replacement' }
  let confirmation = deferred()
  const { handlePlay, chosen } = load([
    'let toggleMusicInfo;',
    handler.getText(parsed),
    'module.exports = { handlePlay, chosen: () => toggleMusicInfo };',
  ].join('\n'), {}, {
    Error,
    musicInfo: { name: 'song', singer: 'artist' },
    playerState: { playMusicInfo: {}, playing: false },
    addPlayLaterMusic(tracks, name, source, isTop) {
      assert.equal(tracks[0], music)
      assert.equal(name, 'song artist')
      assert.equal(source, 'search')
      assert.equal(isTop, true)
      return confirmation.promise
    },
    showNotify: (message) => calls.push(message),
    skipNext: () => calls.push('next'),
    play: () => calls.push('play'),
  })
  const rejected = handlePlay(music)
  confirmation.reject(new Error('queue write failed'))
  await rejected
  assert.deepEqual(calls, ['queue write failed'])
  assert.equal(chosen(), undefined)
  confirmation = deferred()
  const accepted = handlePlay(music)
  assert.deepEqual(calls, ['queue write failed'])
  confirmation.resolve()
  await accepted
  assert.equal(chosen(), music)
  assert.deepEqual(calls, ['queue write failed', 'next', 'play'])
})
