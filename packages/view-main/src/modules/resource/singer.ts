import { deduplicationList } from '@any-listen/common/tools'

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
