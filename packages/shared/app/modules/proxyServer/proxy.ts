import fs, { type ReadStream } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import { PassThrough } from 'node:stream'

import { getMimeType } from '@any-listen/common/mime'
import { isUrl } from '@any-listen/common/utils'
import { extname, getFileStats, joinPath, removeFileIgnoreError } from '@any-listen/nodejs'
import { request, type Response } from '@any-listen/nodejs/request'

import { logs } from '../logs'
import { checkAllowedExt, parseRange, TEMP_FILE_EXT } from './shared'
import { proxyServerState, type ProxyState } from './state'

export interface Result {
  statusCode: number
  headers: Response<unknown>['headers']
  body?: ReadStream | PassThrough
}

// const NOT_FOUND_RESULT: Result = {
//   statusCode: 404,
//   headers: {
//     'content-type': 'text/plain',
//   },
// }
const RANGE_NOT_SATISFIABLE_RESULT: Result = {
  statusCode: 416,
  headers: {
    'content-type': 'text/plain',
  },
}

const getCachedFile = async (proxyServerState: ProxyState, id: string, rangeHeader?: string): Promise<Result | null> => {
  const filePath = joinPath(proxyServerState.cacheDir, id)
  const stat = await getFileStats(filePath)
  if (!stat) return null
  const range = parseRange(rangeHeader)
  const size = stat.size
  let finalStart = 0
  let finalEnd = size - 1
  if (range) {
    if (!size) return { ...RANGE_NOT_SATISFIABLE_RESULT, headers: { 'content-range': `bytes */${size}` } }
    if (range.start != null) {
      if (range.start >= size || !Number.isSafeInteger(range.start))
        return { ...RANGE_NOT_SATISFIABLE_RESULT, headers: { 'content-range': `bytes */${size}` } }
      finalStart = range.start
      if (range.end != null) {
        if (range.end < range.start || !Number.isSafeInteger(range.end)) return RANGE_NOT_SATISFIABLE_RESULT
        finalEnd = Math.min(range.end, size - 1)
      }
    } else if (range.end != null) {
      if (range.end <= 0 || !Number.isSafeInteger(range.end)) return RANGE_NOT_SATISFIABLE_RESULT
      finalStart = Math.max(0, size - range.end)
    }
  }

  return {
    headers: {
      ...(range ? { 'content-range': `bytes ${finalStart}-${finalEnd}/${size}` } : {}),
      'accept-ranges': 'bytes',
      'content-length': (finalEnd - finalStart + 1).toString(),
      'content-type': getMimeType(id),
      'cache-control': 'public, max-age=31536000, immutable',
      'last-modified': stat.mtime.toUTCString(),
    },
    statusCode: range ? 206 : 200,
    body: fs.createReadStream(filePath, size ? { start: finalStart, end: finalEnd } : {}),
  }
}

const isFullRange = (contentRange?: string, size?: number) => {
  if (!contentRange || size == null) return true
  const result = /bytes (\d+)-(\d+)(?:\/(\d+))?/.exec(contentRange)
  if (!result) return true
  const start = parseInt(result[1], 10)
  const end = parseInt(result[2], 10)
  const total = result[3] ? parseInt(result[3], 10) : size
  return start === 0 && end === total - 1
}
const hopByHopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]
const excludeHeaders = [
  // hop-by-hop
  ...hopByHopHeaders,

  // source leaking
  'host',
  'origin',
  'referer',
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',

  // optional
  'cookie',
]
const excludeResponseHeaders = [...hopByHopHeaders, 'set-cookie']
const removeExcludeHeaders = (headers?: IncomingHttpHeaders, excludeList: string[] = excludeHeaders) => {
  if (headers) {
    for (const header of excludeList) {
      if (header in headers) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete headers[header]
      }
    }
  }
}

const filterResponseHeaders = (headers: Record<string, string | string[]>) => {
  const newHeaders = { ...headers }
  removeExcludeHeaders(newHeaders, excludeResponseHeaders)
  if (newHeaders['content-disposition']) {
    const value = newHeaders['content-disposition'] as string
    const match = /filename\*=UTF-8''[^;]+/i.exec(value)
    if (match) {
      newHeaders['content-disposition'] = `attachment; ${match[0]}`
    }
  }
  return newHeaders
}
export const createProxyRequests = (proxyServerState: ProxyState, requestResource = request) => {
  const proxyRequest = async (name: string, rawHeaders?: IncomingHttpHeaders, signal?: AbortSignal): Promise<Result | null> => {
    if (name.length > 128 || !/^[\w.]+$/.test(name)) return null

    const ext = extname(name)
    if (ext && !checkAllowedExt(ext)) return null

    // check cache
    if (signal?.aborted) return null
    const result = await getCachedFile(proxyServerState, name, rawHeaders?.range)
    if (result) {
      if (signal?.aborted) {
        result.body?.destroy()
        return null
      }
      if (signal && result.body) {
        const body = result.body
        const abort = () => body.destroy()
        signal.addEventListener('abort', abort, { once: true })
        body.once('close', () => signal.removeEventListener('abort', abort))
      }
      return result
    }

    const proxyInfo = proxyServerState.proxyMap.get(name)
    if (!proxyInfo) return null

    rawHeaders = { ...rawHeaders }
    removeExcludeHeaders(rawHeaders)

    const resp = await requestResource<ReadStream>(proxyInfo.url, {
      ...proxyInfo.requestOptions,
      headers: {
        ...((rawHeaders ?? {}) as Record<string, string | string[]>),
        ...(proxyInfo.requestOptions.headers ?? {}),
      },
      needBody: true,
      signal:
        signal && proxyInfo.requestOptions.signal
          ? AbortSignal.any([signal, proxyInfo.requestOptions.signal])
          : (signal ?? proxyInfo.requestOptions.signal),
    })

    if (!resp.statusCode || resp.statusCode < 200 || (resp.statusCode >= 300 && resp.statusCode !== 304)) {
      resp.body.destroy()
      console.log(`Proxy request failed: ${resp.statusCode}`)
      return null
    }

    let tee: PassThrough | undefined
    if (
      proxyInfo.enabledCache &&
      resp.statusCode !== 304 &&
      isFullRange(resp.headers['content-range'], parseInt(resp.headers['content-length'] ?? '0', 10)) &&
      !proxyServerState.activeWriteStreams.has(name)
    ) {
      // If the range is not specified, we can cache the entire file
      const filePath = joinPath(proxyServerState.cacheDir, name)
      const tempPath = `${filePath}${TEMP_FILE_EXT}`
      await removeFileIgnoreError(filePath)
      if (signal?.aborted || resp.body.destroyed) {
        resp.body.destroy()
        return null
      }
      // use PassThrough to pipe the response body to both the caller and the file
      tee = new PassThrough()
      resp.body.pipe(tee)
      const writeStream = fs.createWriteStream(tempPath, { flags: 'w' })
      resp.body.pipe(writeStream)
      tee.once('close', () => {
        if (!resp.body.readableEnded) resp.body.destroy()
        if (!writeStream.writableFinished) writeStream.destroy()
      })
      resp.body.on('error', (err) => {
        console.log('resp body error', err)
        logs.ProxyService.logcat.error(`resp body error, name: ${name}`, err)
        writeStream.destroy()
        tee?.destroy()
      })
      writeStream.on('finish', () => {
        fs.rename(tempPath, filePath, (err) => {
          if (err) fs.unlink(tempPath, () => {})
        })
      })
      writeStream.on('error', (err) => {
        logs.ProxyService.logcat.error(`writeStream error, name: ${name}`, err)
        resp.body.destroy()
        tee?.destroy()
      })
      writeStream.on('close', () => {
        proxyServerState.activeWriteStreams.delete(name)
        if (!writeStream.writableFinished) fs.unlink(tempPath, () => {})
      })
      proxyServerState.activeWriteStreams.set(name, writeStream)
    }
    return {
      statusCode: resp.statusCode,
      headers: filterResponseHeaders(resp.headers),
      body: tee || resp.body,
    }
  }

  const proxyRequestByUrl = async (
    url: string,
    rawHeaders?: IncomingHttpHeaders,
    signal?: AbortSignal
  ): Promise<Result | null> => {
    if (url.length > 4096 || !isUrl(url)) {
      logs.ProxyService.logcat.warn(`Invalid URL: ${url}`)
      return null
    }

    const ext = extname(url)
    if (ext && !checkAllowedExt(ext)) {
      logs.ProxyService.logcat.warn(`Not allowed file type: ${ext}, url: ${url}`)
      return null
    }

    rawHeaders = { ...rawHeaders }
    removeExcludeHeaders(rawHeaders)

    const resp = await requestResource<ReadStream>(url, {
      headers: rawHeaders as Record<string, string | string[]>,
      needBody: true,
      signal,
    })

    if (!resp.statusCode || resp.statusCode < 200 || (resp.statusCode >= 300 && resp.statusCode !== 304)) {
      resp.body.destroy()
      logs.ProxyService.logcat.warn(
        `Proxy request failed: ${resp.statusCode}, url: ${url}, headers: ${JSON.stringify(rawHeaders)}`
      )
      console.log(`Proxy request failed: ${resp.statusCode}`)
      return null
    }

    return {
      statusCode: resp.statusCode,
      headers: filterResponseHeaders(resp.headers),
      body: resp.body,
    }
  }
  return { proxyRequest, proxyRequestByUrl }
}

export const { proxyRequest, proxyRequestByUrl } = createProxyRequests(proxyServerState)
