import { randomUUID } from 'node:crypto'
import path from 'node:path'

import type { createProxy } from '@any-listen/app/modules/proxyServer'
import { buildVirtualPublicPath } from '@any-listen/common/tools'

import { PUBLIC_RESOURCE_PATH } from '@/shared/constants'

import type { SharedResult } from './sharedExtensions'

export const materializeSourceResult = async ({ value, assets }: SharedResult,
  proxy: typeof createProxy,
  registerFile: (name: string, file: string) => void) => {
  const urls = new Map<string, string>()
  for (const [token, asset] of Object.entries(assets)) {
    if ('url' in asset) urls.set(token, await proxy(asset.url, asset.options, asset.cache))
    else {
      const name = randomUUID() + path.extname(asset.file)
      registerFile(name, asset.file)
      // Static files have the same account authentication as proxy streams.
      urls.set(token, buildVirtualPublicPath(PUBLIC_RESOURCE_PATH, name))
    }
  }
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return urls.get(item) ?? item
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, visit(value)]))
    return item
  }
  return visit(value)
}
