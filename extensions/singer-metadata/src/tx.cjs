const { get, pageResult, artist, music } = require('./common.cjs')
const call = async (module, method, param) => {
  const data = await get('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    data: JSON.stringify({ comm: { ct: 11, cv: '1003006', v: '1003006', tmeAppID: 'qqmusic', tmeLoginType: 2 }, req: { module, method, param } }),
  })
  if (data.code !== 0 || data.req?.code !== 0) throw new Error(`QQ歌手接口失败：${data.code}/${data.req?.code}`)
  return data.req.data
}
exports.search = async ({ keyword, page, limit }) => {
  const data = await call('music.search.SearchCgiService', 'DoSearchForQQMusicMobile', {
    query: keyword, search_type: 1, num_per_page: limit, page_num: page, grp: 1,
  })
  if (data.meta.is_filter < 0) throw new Error('QQ歌手搜索被平台限制')
  return pageResult(data.body.singer.map(s => artist(s.singerMID, s.singerName, s.singerPic)), data.meta.sum, page, limit)
}
exports.detail = async ({ id, page, limit }) => {
  const data = await call('music.web_singer_info_svr', 'get_singer_detail_info', { singermid: id, sort: 5, sin: (page - 1) * limit, num: limit })
  const list = data.songlist.map(s => {
    const qualitys = {}
    for (const [key, field] of [['128k', 'size_128mp3'], ['320k', 'size_320mp3'], ['flac', 'size_flac'], ['flac24bit', 'size_hires']]) {
      if (s.file[field]) qualitys[key] = { sizeStr: `${(s.file[field] / 1048576).toFixed(2)} MB` }
    }
    return music('tx', s.mid, s.title, s.singer.map(a => a.name).join('、'), s.interval, {
      albumName: s.album.name, albumId: s.album.mid, albumMid: s.album.mid, songId: String(s.id),
      strMediaMid: s.file.media_mid, qualitys, picUrl: `https://y.gtimg.cn/music/photo_new/T002R500x500M000${s.album.mid}.jpg`,
    })
  })
  return { ...pageResult(list, data.total_song, page, limit), info: artist(id, data.singer_info.name, `https://y.gtimg.cn/music/photo_new/T001R500x500M000${id}.jpg`) }
}
