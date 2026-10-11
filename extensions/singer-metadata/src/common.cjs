const api = require('any-listen')

const query = (params) => Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
const get = async (url, params) => {
  const { statusCode, body } = await api.request(`${url}?${query(params)}`, { timeout: 15000 })
  if (statusCode !== 200) throw new Error(`歌手接口 HTTP ${statusCode}`)
  return typeof body === 'string' ? JSON.parse(body) : body
}
const pageResult = (list, total, page, limit) => {
  total = Number(total)
  if (!Array.isArray(list) || !Number.isSafeInteger(total) || total < 0) throw new Error('歌手接口返回了无效列表')
  return { list, total, page, limit }
}
const artist = (id, name, img) => {
  if (id == null || !name) throw new Error('歌手接口缺少 ID 或名称')
  return { id: String(id), name, ...(img ? { img } : {}) }
}
const music = (source, id, name, singer, seconds, meta) => {
  if (id == null || !name) throw new Error('作品接口缺少歌曲 ID 或名称')
  return {
    id: `${source}_${id}`, name, singer, isLocal: false,
    interval: seconds ? `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : null,
    meta: { source, musicId: String(id), albumName: '', qualitys: {}, createTime: 0, posTime: 0, updateTime: 0, ...meta },
  }
}
module.exports = { api, get, pageResult, artist, music }
