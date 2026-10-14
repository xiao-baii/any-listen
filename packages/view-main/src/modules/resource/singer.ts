import { deduplicationList } from '@any-listen/common/tools'
import { generateId, getRandom } from '@any-listen/common/utils'

import { singer } from '@/shared/ipc/resource'

export const getSingerMusics = async (extensionId: string, source: string, id: string) => {
  const first = await singer({ extensionId, source, id, page: 1, limit: 10000 })
  const list = [...first.list]
  for (let page = 2; page <= Math.ceil(first.total / first.limit); page++) {
    const result = await singer({ extensionId, source, id, page, limit: first.limit })
    list.push(...result.list)
  }
  return deduplicationList(list)
}

export const prepareSingerPlayback = async (
  extensionId: string,
  source: string,
  id: string,
  current: AnyListen.IPCExtension.SingerDetailResult,
  musicId: string,
  random?: boolean
) => {
  if (random === true) {
    const list = await getSingerMusics(extensionId, source, id)
    return { list, index: getRandom(0, list.length), singerQueue: undefined }
  }
  const page = random === false && current.page !== 1
    ? await singer({ extensionId, source, id, page: 1, limit: current.limit })
    : current
  const list = deduplicationList(page.list)
  return {
    list, index: random === false ? 0 : list.findIndex(item => item.id === musicId),
    singerQueue: {
      queueId: generateId(), extensionId, source, singerId: id,
      startPage: page.page, nextPage: page.page + 1, limit: page.limit,
      ended: !page.list.length || page.page * page.limit >= page.total,
    } satisfies AnyListen.Player.SingerQueue,
  }
}
