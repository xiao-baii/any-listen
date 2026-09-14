import type { WriteStream } from 'node:fs'

import { createCache } from '@any-listen/common/cache'
import type { Options } from '@any-listen/nodejs/request'

export const createProxyState = () => ({
  proxyHost: '',
  proxyBaseUrl: '',
  cacheDir: '',
  proxyMap: createCache<{
    requestOptions: Options
    url: string
    enabledCache?: boolean
  }>({
    max: 1000,
    ttl: 1000 * 60 * 60 * 6,
  }),
  activeWriteStreams: new Map<string, WriteStream>(),
  proxyUrlKey: '',
})

export type ProxyState = ReturnType<typeof createProxyState>
export const proxyServerState = createProxyState()
