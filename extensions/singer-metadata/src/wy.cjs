const { get, pageResult, artist, music } = require('./common.cjs')
const call = async (path, params) => {
  const data = await get(`https://music.163.com/api/${path}`, params)
  if (data.code !== 200) throw new Error(`网易云歌手接口失败：${data.code}`)
  return data
}
exports.search = async ({ keyword, page, limit }) => {
  const { result } = await call('search/get', { s: keyword, type: 100, offset: (page - 1) * limit, limit })
  return pageResult((result.artists ?? []).map(s => artist(s.id, s.name, s.picUrl)), result.artistCount, page, limit)
}
exports.detail = async ({ id, page, limit }) => {
  const [{ data }, result] = await Promise.all([
    call('artist/head/info/get', { id }),
    call('v1/artist/songs', { id, order: 'hot', offset: (page - 1) * limit, limit }),
  ])
  const list = result.songs.map(s => {
    const qualitys = {}
    for (const [key, field] of [['128k', 'lMusic'], ['320k', 'hMusic'], ['flac', 'sqMusic'], ['flac24bit', 'hrMusic']]) {
      if (s[field]?.size) qualitys[key] = { sizeStr: `${(s[field].size / 1048576).toFixed(2)} MB` }
    }
    return music('wy', s.id, s.name, s.artists.map(a => a.name).join('、'), s.duration / 1000,
      { albumName: s.album.name, albumId: String(s.album.id), picUrl: s.album.picUrl, qualitys })
  })
  return { ...pageResult(list, result.total, page, limit), info: artist(id, data.artist.name, data.artist.cover) }
}
