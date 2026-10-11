const { api } = require('./common.cjs')
const sources = { wy: require('./wy.cjs'), tx: require('./tx.cjs'), kg: require('./kg.cjs'), kw: require('./kw.cjs'), mg: require('./mg.cjs') }
const params = input => {
  if (!Object.hasOwn(sources, input.source)) throw new Error('不支持的歌手平台')
  if (!Number.isSafeInteger(input.page) || input.page < 1) throw new Error('无效页码')
  if (input.limit != null && (!Number.isSafeInteger(input.limit) || input.limit < 1)) throw new Error('无效分页大小')
  return { ...input, limit: Math.min(input.limit ?? 30, 30) }
}
api.registerResourceAction({
  singerSearch(input) {
    const p = params(input)
    if (typeof p.keyword !== 'string' || !p.keyword.trim()) throw new Error('请输入歌手名')
    return sources[p.source].search(p)
  },
  singer(input) {
    const p = params(input)
    if (typeof p.id !== 'string' || !p.id) throw new Error('缺少歌手 ID')
    return sources[p.source].detail(p)
  },
})
