const { api, get, pageResult, artist, music } = require('./common.cjs')
const check = data => {
  if (data.status !== 1) throw new Error(`酷狗歌手接口失败：${data.error_code ?? data.errcode}`)
  return data.data
}
exports.search = async ({ keyword, page, limit }) => {
  const params = { appid: 1005, clientver: 20489, clienttime: Math.floor(Date.now() / 1000), mid: '0', uuid: '0', dfid: '-', userid: 0, keyword, page, pagesize: limit, platform: 'AndroidFilter' }
  const salt = 'OIlwieks28dk2k092lksi2UIkp'
  params.signature = await api.utils.crypto.md5(salt + Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('') + salt)
  const data = check(await get('https://complexsearch.kugou.com/v1/search/author', params))
  return pageResult(data.lists.map(s => artist(s.AuthorId, s.AuthorName, s.Avatar)), data.total, page, limit)
}
exports.detail = async ({ id, page, limit }) => {
  const [rawInfo, rawData] = await Promise.all([
    get('http://mobilecdn.kugou.com/api/v3/singer/info', { singerid: id }),
    get('http://mobilecdn.kugou.com/api/v3/singer/song', { singerid: id, page, pagesize: limit }),
  ])
  const info = check(rawInfo), data = check(rawData)
  const list = data.info.map(s => {
    const qualitys = {}
    for (const [key, hash, size] of [['128k', 'hash', 'filesize'], ['320k', '320hash', '320filesize'], ['flac', 'sqhash', 'sqfilesize'], ['flac24bit', 'hash_high', 'filesize_high']]) {
      if (s[hash] && s[size]) qualitys[key] = { hash: s[hash], sizeStr: `${(s[size] / 1048576).toFixed(2)} MB` }
    }
    const split = s.filename.indexOf(' - ')
    const song = music('kg', s.audio_id, split < 0 ? s.filename : s.filename.slice(split + 3), split < 0 ? info.singername : s.filename.slice(0, split), s.duration, {
      albumName: s.album_name, albumId: s.album_id, albumAudioId: s.album_audio_id, hash: s.hash, _interval: s.duration,
      qualitys, picUrl: s.trans_param?.union_cover?.replace('{size}', '400'),
    })
    song.id += `_${s.hash}`
    return song
  })
  return { ...pageResult(list, data.total, page, limit), info: artist(id, info.singername, info.imgurl?.replace('{size}', '400')) }
}
