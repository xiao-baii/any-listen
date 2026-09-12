import type { IncomingHttpHeaders } from 'node:http'

import { logs } from '@any-listen/app/modules/logs'
import { proxyRequest, proxyRequestByUrl, getProxyUrlKey } from '@any-listen/app/modules/proxyServer'
import { PROXY_SERVER_PATH, PROXY_URL_PATH, PROXY_URL_KEY_COOKIE_NAME } from '@any-listen/common/constants'
import type Router from '@koa/router'

import { managed } from '@/accounts/managed'

import { authConnect } from './ipc/auth'

const mediaHeaders = (headers: IncomingHttpHeaders) => {
  const result = { ...headers }
  // Preserve the request identity for middleware; never forward it to a music origin.
  if (managed)
    for (const key of Object.keys(result)) {
      if (key.startsWith('x-anylisten-') || key === 'authorization') delete result[key]
    }
  return result
}

export const registerProxyRouter = (router: Router<unknown, AnyListen.RequestContext>) => {
  router.get(`${PROXY_SERVER_PATH}/:name`, async (ctx, next) => {
    const result = await proxyRequest(ctx.params.name, mediaHeaders(ctx.headers))
    if (!result) {
      ctx.status = 404
      ctx.body = 'Not Found'
      return
    }
    ctx.status = result.statusCode
    for (const [k, v] of Object.entries(result.headers)) {
      if (!v) continue
      try {
        ctx.set(k, v)
      } catch (e) {
        logs.ProxyService.logcat.warn(`invalid header: ${k}`, v, e)
      }
    }
    ctx.body = result.body
  })
  router.get('/proxyUrlToken', async (ctx, next) => {
    const keyInfo = await authConnect(ctx.req).catch(() => null)
    if (!keyInfo) {
      ctx.status = 401
      ctx.body = 'Unauthorized'
      return
    }
    ctx.cookies.set(PROXY_URL_KEY_COOKIE_NAME, await getProxyUrlKey(), {
      httpOnly: true,
      sameSite: 'strict',
      // maxAge: 36500 * 24 * 3600 * 1000,
      maxAge: 0,
    })
    ctx.status = 200
    ctx.body = 'OK'
  })
  router.get(`${PROXY_URL_PATH}/:url`, async (ctx, next) => {
    if (import.meta.env.PROD && !managed) {
      if (ctx.cookies.get(PROXY_URL_KEY_COOKIE_NAME) !== (await getProxyUrlKey())) {
        ctx.status = 403
        ctx.body = 'Forbidden'
        return
      }
    }
    try {
      const result = await proxyRequestByUrl(ctx.params.url, mediaHeaders(ctx.headers))
      if (!result) {
        ctx.status = 404
        ctx.body = 'Not Found'
        return
      }
      ctx.status = result.statusCode
      for (const [k, v] of Object.entries(result.headers)) {
        ctx.set(k, v)
      }
      ctx.body = result.body
    } catch (err) {
      logs.ProxyService.logcat.error(`proxyRequestByUrl error, url: ${ctx.params.url}`, err)
      ctx.status = 500
      ctx.body = 'Internal Server Error'
    }
  })
}
