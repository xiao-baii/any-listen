const assert = require('node:assert/strict')
const { load, request } = require('./runtime.cjs')
async function main() {
  const actions = await load(request)
  for (const source of ['wy', 'tx', 'kg', 'kw', 'mg']) {
    try {
      const search = await actions.singerSearch({ source, keyword: '周杰伦', page: 1, limit: 2 })
      assert(search.list.length > 0)
      const artist = search.list.find(s => s.name === '周杰伦')
      assert(artist, 'Expected exact artist')
      const first = await actions.singer({ source, id: artist.id, page: 1, limit: 2 })
      const second = await actions.singer({ source, id: artist.id, page: 2, limit: 2 })
      assert.equal(first.info.name, '周杰伦')
      assert.equal(first.list.length, 2)
      assert.equal(second.list.length, 2)
      assert(first.total > 2)
      assert.notEqual(first.list[0].id, second.list[0].id)
      for (const song of [...first.list, ...second.list]) {
        assert.equal(song.meta.source, source)
        assert(song.meta.musicId)
        assert(Object.keys(song.meta.qualitys).length > 0, 'No playable quality metadata')
        if (source === 'tx') assert(song.meta.strMediaMid && song.meta.songId)
        if (source === 'kg') assert(song.meta.hash)
        if (source === 'mg') assert(song.meta.copyrightId && song.meta.contentId)
      }
      const broad = await actions.singerSearch({ source, keyword: '周', page: 1, limit: 2 })
      const next = await actions.singerSearch({ source, keyword: '周', page: 2, limit: 2 })
      assert(broad.list.length && next.list.length)
      assert.notEqual(broad.list[0].id, next.list[0].id)
      console.log(`${source}: PASS search=${search.total}, works=${first.total}, searchLimit=${search.limit}`)
    } catch (error) {
      console.error(`${source}: FAIL ${error.stack}`)
      process.exitCode = 1
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
