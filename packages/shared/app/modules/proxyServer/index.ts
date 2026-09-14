import fs from 'node:fs/promises'

import { buildVirtualPublicPath } from '@any-listen/common/tools'
import { checkAndCreateDir, checkFile, extname, joinPath, randomBytes, toMD5, toSha256 } from '@any-listen/nodejs'
import { verifyResource, type Options } from '@any-listen/nodejs/request'

import { createProxyRequests } from './proxy'
// import { logs } from '../logs'
import { checkAllowedExt } from './shared'
import { createProxyState, proxyServerState } from './state'

export const generateName = (url: string) => {
  if (url.length > 2048) throw new Error('URL too long')

  const ext = extname(url)
  if (ext && !checkAllowedExt(ext)) throw new Error('Not allowed file type')

  return (toSha256(`${url}.${Date.now()}`) + ext).toLowerCase()
}

export const createProxyService = (state = createProxyState()) => {
  let closed = false
  const checkOpen = () => {
    if (closed) throw new Error('Resource proxy is closed')
  }
  const controller = new AbortController()
  const writes = new Set<Promise<void>>()
  const requests = createProxyRequests(state)
  const createProxy = async (url: string, reqOptions: Options = {}, enabledCache?: boolean) => {
    checkOpen()
    // logs.ProxyService.logcat.info('createProxy', url, reqOptions, enabledCache)
    await verifyResource(url, {
      ...reqOptions,
      signal: reqOptions.signal ? AbortSignal.any([reqOptions.signal, controller.signal]) : controller.signal,
    })
    checkOpen()

    const name = generateName(url)
    state.proxyMap.set(name, {
      requestOptions: reqOptions,
      url,
      enabledCache,
    })
    return buildVirtualPublicPath(state.proxyBaseUrl, name)
  }

  const checkProxyCache = async (url: string) => {
    checkOpen()
    const name = generateName(url)
    return checkFile(joinPath(state.cacheDir, name))
  }

  const writeProxyCache = async (fileName: string, data: Uint8Array) => {
    checkOpen()
    const name = generateName(fileName)
    const filePath = joinPath(state.cacheDir, name)
    const write = fs.writeFile(filePath, data)
    writes.add(write)
    try {
      await write
    } finally {
      writes.delete(write)
    }
    checkOpen()
    return buildVirtualPublicPath(state.proxyBaseUrl, name)
  }

  const initProxyServer = async (proxyHost: string, proxyBaseUrl: string, cacheDir: string) => {
    checkOpen()
    // server ||= http.createServer()
    state.proxyHost = proxyHost
    state.proxyBaseUrl = proxyBaseUrl
    state.cacheDir = `${cacheDir}/proxy`
    await checkAndCreateDir(state.cacheDir)
  }

  const getProxyUrlKey = async () => {
    checkOpen()
    if (state.proxyUrlKey) return state.proxyUrlKey
    const key = toMD5(randomBytes(16))
    state.proxyUrlKey = key
    return key
  }

  const proxyRequest: typeof requests.proxyRequest = async (name, headers, signal) => {
    checkOpen()
    return requests.proxyRequest(name, headers, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
  }
  const proxyRequestByUrl: typeof requests.proxyRequestByUrl = async (url, headers, signal) => {
    checkOpen()
    return requests.proxyRequestByUrl(url, headers, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
  }
  return {
    state,
    createProxy,
    checkProxyCache,
    writeProxyCache,
    initProxyServer,
    getProxyUrlKey,
    proxyRequest,
    proxyRequestByUrl,
    async close() {
      closed = true
      controller.abort()
      state.proxyMap.clear()
      state.proxyUrlKey = ''
      await Promise.allSettled(writes)
      await Promise.all(
        [...state.activeWriteStreams.values()].map(
          (stream) =>
            new Promise<void>((resolve) => {
              if (stream.closed) {
                resolve()
                return
              }
              stream.once('close', resolve)
              stream.destroy()
            })
        )
      )
      state.activeWriteStreams.clear()
    },
  }
}

export const {
  createProxy,
  checkProxyCache,
  writeProxyCache,
  initProxyServer,
  getProxyUrlKey,
  proxyRequest,
  proxyRequestByUrl,
  close: closeProxyServer,
} = createProxyService(proxyServerState)
export { proxyServerState } from './state'
