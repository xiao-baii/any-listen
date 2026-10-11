const assert = require('node:assert/strict')
const { test } = require('node:test')
const { load } = require('./runtime.cjs')
const fixtures = require('./fixtures.json')

function operation(raw) {
  const url = new URL(raw)
  if (url.hostname === 'music.163.com') return ['wy', url.pathname.includes('search') ? 'search' : url.pathname.includes('head') ? 'info' : 'detail']
  if (url.hostname === 'u.y.qq.com') return ['tx', JSON.parse(url.searchParams.get('data')).req.method.includes('Search') ? 'search' : 'detail']
  if (url.hostname === 'search.kuwo.cn') return ['kw', url.searchParams.has('stype') ? 'info' : url.searchParams.get('ft') === 'artist' ? 'search' : 'detail']
  if (url.hostname.includes('kugou')) return ['kg', url.pathname.includes('search') ? 'search' : url.pathname.endsWith('info') ? 'info' : 'detail']
  return ['mg', url.pathname.includes('search') ? 'search' : 'detail']
}
const mock = (change = () => {}) => load(async url => {
  const [source, kind] = operation(url)
  const body = structuredClone(fixtures[source][kind])
  change(body, source, kind, new URL(url))
  return { statusCode: 200, body }
})

for (const source of Object.keys(fixtures)) {
  test(`${source}: converts real search and work responses with playback identifiers`, async () => {
    const actions = await mock()
    const search = await actions.singerSearch({ source, keyword: '周杰伦', page: 1, limit: 2 })
    assert.equal(search.list[0].name, '周杰伦')
    assert.equal(search.limit, source === 'mg' ? 20 : 2)
    const detail = await actions.singer({ source, id: search.list[0].id, page: 2, limit: 10000 })
    assert.equal(detail.info.name, '周杰伦')
    assert.equal(detail.page, 2)
    assert.equal(detail.limit, 30)
    assert(detail.total > 0)
    assert.equal(detail.list.length, 1)
    const song = detail.list[0]
    assert.equal(song.meta.source, source)
    assert(song.meta.musicId)
    assert(Object.keys(song.meta.qualitys).length)
    if (source === 'tx') assert(song.meta.strMediaMid && song.meta.songId)
    if (source === 'kg') assert(song.meta.hash && song.meta.qualitys['128k'].hash)
    if (source === 'mg') {
      assert(song.meta.copyrightId && song.meta.contentId)
      assert.equal(song.interval, '03:02')
    }
  })
  test(`${source}: propagates invalid responses instead of returning a false empty page`, async () => {
    const actions = await load(async () => ({ statusCode: 200, body: {} }))
    await assert.rejects(actions.singerSearch({ source, keyword: '周', page: 1 }))
    await assert.rejects(actions.singer({ source, id: '1', page: 1 }))
  })
}
test('empty search results keep the real zero total', async () => {
  const actions = await mock((body, source, kind) => {
    if (kind !== 'search') return
    if (source === 'wy') body.result = { artistCount: 0 }
    if (source === 'tx') { body.req.data.body.singer = []; body.req.data.meta.sum = 0 }
    if (source === 'kg') { body.data.lists = []; body.data.total = 0 }
    if (source === 'kw') { body.abslist = []; body.TOTAL = '0' }
    if (source === 'mg') body.singerResultData = { totalCount: '0' }
  })
  for (const source of Object.keys(fixtures)) {
    const result = await actions.singerSearch({ source, keyword: 'unknown', page: 1 })
    assert.equal(result.total, 0)
    assert.equal(result.list.length, 0)
  }
})
test('pagination uses the requested page with the effective limit', async () => {
  const actions = await mock((body, source, kind, url) => {
    if (kind !== 'detail') return
    if (source === 'wy') assert.equal(url.searchParams.get('offset'), '30')
    if (source === 'tx') assert.equal(JSON.parse(url.searchParams.get('data')).req.param.sin, 30)
    if (source === 'kw') assert.equal(url.searchParams.get('pn'), '1')
    if (source === 'kg') assert.equal(url.searchParams.get('page'), '2')
    if (source === 'mg') assert.equal(url.searchParams.get('pageNo'), '2')
  })
  for (const source of Object.keys(fixtures)) await actions.singer({ source, id: '1', page: 2, limit: 10000 })
})
test('rejects unknown sources, invalid pages and HTTP errors', async () => {
  const actions = await load(async () => ({ statusCode: 503 }))
  assert.throws(() => actions.singerSearch({ source: '__proto__', page: 1, keyword: 'a' }))
  assert.throws(() => actions.singer({ source: 'wy', page: 0, id: '1' }))
  assert.throws(() => actions.singer({ source: 'wy', page: 1, limit: -1, id: '1' }))
  await assert.rejects(actions.singer({ source: 'wy', page: 1, id: '1' }), /HTTP 503/)
})
