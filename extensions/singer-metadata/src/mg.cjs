const { get, pageResult, artist, music } = require('./common.cjs')
const call = async (path, params) => {
  const data = await get(`https://c.musicapp.migu.cn/v1.0/content/${path}.do`, params)
  if (data.code !== '000000') throw new Error(`咪咕歌手接口失败：${data.code}`)
  return data
}
exports.search = async ({ keyword, page }) => {
  // The singer endpoint ignores pageSize and always uses 20 items per page.
  const data = await call('search_all', { text: keyword, pageNo: page, searchSwitch: JSON.stringify({ singer: 1 }) })
  const result = data.singerResultData
  return pageResult((result.result ?? []).map(s => artist(s.id, s.name)), result.totalCount, page, 20)
}
exports.detail = async ({ id, page, limit }) => {
  const data = await call('singer_songs', { singerId: id, resourceType: 2, pageNo: page, pageSize: limit })
  const list = data.songlist.map(s => {
    const qualitys = {}
    for (const format of s.newRateFormats ?? []) {
      const key = { PQ: '128k', HQ: '320k', SQ: 'flac', ZQ: 'flac24bit' }[format.formatType]
      if (key) qualitys[key] = { sizeStr: `${(Number(format.size ?? format.androidSize) / 1048576).toFixed(2)} MB` }
    }
    const seconds = s.length?.split(':').reduce((total, part) => total * 60 + Number(part), 0)
    return music('mg', s.songId, s.songName, s.singer, seconds, {
      albumName: s.album, albumId: s.albumId, copyrightId: s.copyrightId, contentId: s.contentId,
      qualitys, picUrl: s.albumImgs?.[0]?.img, lrcUrl: s.lrcUrl,
    })
  })
  return { ...pageResult(list, data.songNum, page, limit), info: artist(id, data.singer.singer, data.singer.imgs?.[0]?.img) }
}
