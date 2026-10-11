const { get, pageResult, artist, music } = require('./common.cjs')
const call = params => get('https://search.kuwo.cn/r.s', {
  rformat: 'json', encoding: 'utf8', mobi: 1, vipver: 1, show_copyright_off: 1, ...params,
})
const picture = path => path ? `https://img1.kuwo.cn/star/starheads/${path}` : undefined
exports.search = async ({ keyword, page, limit }) => {
  const data = await call({ all: keyword, ft: 'artist', pn: page - 1, rn: limit })
  return pageResult((data.abslist ?? []).map(s => artist(s.ARTISTID, s.ARTIST, picture(s.PICPATH))), data.TOTAL, page, limit)
}
exports.detail = async ({ id, page, limit }) => {
  const [info, data] = await Promise.all([
    call({ stype: 'artistinfo', artistid: id }),
    call({ artistid: id, ft: 'music', pn: page - 1, rn: limit }),
  ])
  const list = (data.abslist ?? []).map(s => {
    const qualitys = {}
    for (const match of (s.N_MINFO ?? '').matchAll(/bitrate:(\d+),format:\w+,size:([\w.]+)/g)) {
      const key = { 128: '128k', 320: '320k', 2000: 'flac', 4000: 'flac24bit' }[match[1]]
      if (key) qualitys[key] = { sizeStr: match[2] }
    }
    const songId = s.MUSICRID.replace('MUSIC_', '')
    return music('kw', songId, s.SONGNAME, s.ARTIST.replace(/&/g, '、'), Number(s.DURATION), {
      albumName: s.ALBUM, albumId: s.ALBUMID, songId, qualitys,
    })
  })
  return { ...pageResult(list, data.TOTAL, page, limit), info: artist(id, info.name, picture(info.pic)) }
}
