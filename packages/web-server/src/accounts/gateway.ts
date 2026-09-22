import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { formatExtensionGHMirrorHosts } from '@any-listen/common/tools'
import { getMimeType } from '@any-listen/common/mime'
import { logs } from '@any-listen/app/modules/logs'

import { Accounts, publicUser, type User, type Session } from './database'
import { Publications } from './publications'
import { Runtimes, type Runtime } from './runtime'
import { AccountError, LoginLimiter, fail, signIdentity, verifyPassword } from './security'

const COOKIE = 'anylisten_session'
const readBody = async (req: IncomingMessage, max = 64 * 1024) => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) fail(413, 'Request too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
const readJson = async (req: IncomingMessage) => {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'Expected application/json')
  try {
    const value: unknown = JSON.parse((await readBody(req)).toString())
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected a JSON object')
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof AccountError) throw error
    return fail(400, 'Invalid JSON')
  }
}
const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}
const cookieToken = (req: IncomingMessage) =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1) ?? ''
type Auth = { user: User; session: Session }

export const createGateway = (accounts: Accounts, runtimes: Runtimes, publicDir: string, configuredOrigin?: string) => {
  const limiter = new LoginLimiter()
  const connections = new Map<string, { userId: string; connections: Set<Socket | ServerResponse> }>()
  const publications = new Publications(accounts, runtimes)
  const siteSettings = () => ({ proxyAllResources: runtimes.proxyAllResources, onlineResourceEnabled: runtimes.onlineResourceEnabled, ghMirrorHosts: runtimes.ghMirrorHosts })
  runtimes.setSiteSettings({
    proxyAllResources: accounts.state('network.proxyAllResources') === 'true',
    onlineResourceEnabled: accounts.state('onlineResource.enable') === 'true',
    ghMirrorHosts: accounts.state('extension.ghMirrorHosts') ?? runtimes.ghMirrorHosts,
  })
  runtimes.prepare = (user) => {
    if (!accounts.get(user.id) || accounts.get(user.id)!.disabled) fail(403, 'Account disabled')
    return publications.apply()
  }
  const originFor = (req: IncomingMessage) => configuredOrigin ?? `http://${req.headers.host}`
  const authFor = (req: IncomingMessage): Auth => accounts.session(cookieToken(req)) ?? fail(401, 'Sign in required')
  const setCookie = (res: ServerResponse, token: string, req: IncomingMessage) =>
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 30 * 86400 : 0}${originFor(req).startsWith('https:') ? '; Secure' : ''}`
    )
  const track = (auth: Auth, connection: Socket | ServerResponse, runtime?: Runtime) => {
    const entry = connections.get(auth.session.id) ?? { userId: auth.user.id, connections: new Set<Socket | ServerResponse>() }
    connections.set(auth.session.id, entry)
    const set = entry.connections
    set.add(connection)
    if (runtime) {
      runtime.active++
      runtime.lastActive = Date.now()
    }
    connection.once('close', () => {
      set.delete(connection)
      if (!set.size) connections.delete(auth.session.id)
      if (runtime) {
        runtime.active--
        runtime.lastActive = Date.now()
      }
    })
  }
  const revoke = (userId: string, sessionId?: string) => {
    for (const [id, entry] of connections) {
      // Sessions have already been removed from SQLite; internal connections retain their owner.
      if (entry.userId !== userId || (sessionId && id !== sessionId)) continue
      for (const connection of entry.connections) connection.destroy()
      connections.delete(id)
    }
  }
  const forwardedHeaders = (req: IncomingMessage, runtime: Runtime, auth: Auth) => {
    const headers = { ...req.headers }
    for (const key of Object.keys(headers))
      if (
        key.startsWith('x-anylisten-') ||
        key.startsWith('x-forwarded-') ||
        ['cookie', 'authorization', 'forwarded', 'm', 's', 'proxy-authorization'].includes(key)
      )
        delete headers[key]
    // Connection tokens may name headers that a downstream HTTP server discards.
    for (const key of (req.headers.connection ?? '').split(',').map((v) => v.trim().toLowerCase()))
      if (key && key !== 'upgrade') delete headers[key]
    headers.connection = req.headers.upgrade ? 'Upgrade' : 'close'
    headers.host = `127.0.0.1:${runtime.port}`
    headers['x-anylisten-identity'] = signIdentity(
      {
        userId: auth.user.id,
        sessionId: auth.session.id,
        role: auth.user.role,
        expires: Math.min(auth.session.expiresAt, Date.now() + 60_000),
      },
      runtime.secret
    )
    return headers
  }
  const userTarget = (url: URL, auth: Auth) => {
    const prefix = `/u/${auth.user.id}/`
    if (!url.pathname.startsWith(prefix)) fail(403, 'Forbidden')
    return `/${url.pathname.slice(prefix.length)}${url.search}`
  }
  const serveStatic = async (req: IncomingMessage, res: ServerResponse, relative: string) => {
    const file = path.resolve(publicDir, relative || 'index.html')
    if (!file.startsWith(path.resolve(publicDir) + path.sep)) fail(404, 'Not found')
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) fail(404, 'Not found')
    res.writeHead(200, {
      'Content-Type': path.extname(file) === '.html' ? 'text/html; charset=utf-8' : getMimeType(file),
      'Cache-Control': /[.-][\w-]{8}\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|svg|ico|wav|mp3)$/.test(path.basename(file))
        ? 'public, max-age=5184000, immutable'
        : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') res.end()
    else
      createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res)
  }
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://gateway')
    if (url.pathname === '/healthz') {
      json(res, 200, { status: 'ok' })
      return
    }
    if (url.pathname.startsWith('/account-api')) {
      if (!['GET', 'HEAD'].includes(req.method!)) {
        if (req.headers.origin !== originFor(req)) fail(403, 'Invalid request origin')
      }
      if (url.pathname === '/account-api/login' && req.method === 'POST') {
        const body = await readJson(req)
        if (typeof body.username !== 'string' || typeof body.password !== 'string') fail(400, 'Username and password required')
        limiter.check(req.socket.remoteAddress ?? '', body.username as string)
        const result = await accounts.login(
          body.username as string,
          body.password as string,
          req.socket.remoteAddress ?? '',
          req.headers['user-agent'] ?? ''
        )
        const previous = accounts.session(cookieToken(req))
        if (previous) {
          accounts.revoke(previous.session.id, previous.user.id)
          revoke(previous.user.id, previous.session.id)
        }
        setCookie(res, result.token, req)
        json(res, 200, { user: result.user })
        return
      }
      const auth = authFor(req)
      const authorize = () => {
        const current = authFor(req)
        if (current.session.id !== auth.session.id || current.user.role !== auth.user.role) fail(401, 'Session expired')
      }
      if (url.pathname === '/account-api/me' && req.method === 'GET') {
        json(res, 200, { user: publicUser(auth.user), sessionId: auth.session.id })
        return
      }
      if (url.pathname === '/account-api/logout' && req.method === 'POST') {
        accounts.revoke(auth.session.id, auth.user.id)
        revoke(auth.user.id, auth.session.id)
        setCookie(res, '', req)
        json(res, 200, { ok: true })
        return
      }
      if (url.pathname === '/account-api/password' && req.method === 'POST') {
        const body = await readJson(req)
        authorize()
        if (!(await verifyPassword(body.currentPassword, auth.user.passwordHash))) fail(400, 'Current password is incorrect')
        authorize()
        await accounts.password(auth.user.id, body.password as string, auth.user.id, auth.user.passwordHash, authorize)
        revoke(auth.user.id)
        setCookie(res, '', req)
        json(res, 200, { ok: true })
        return
      }
      if (url.pathname === '/account-api/sessions' && req.method === 'GET') {
        json(res, 200, { sessions: accounts.sessions(auth.user.id), currentId: auth.session.id })
        return
      }
      const sessionMatch = /^\/account-api\/sessions\/([^/]+)$/.exec(url.pathname)
      if (sessionMatch && req.method === 'DELETE') {
        accounts.revoke(sessionMatch[1], auth.user.id)
        revoke(auth.user.id, sessionMatch[1])
        json(res, 200, { ok: true })
        return
      }
      if (url.pathname === '/account-api/maintenance' && req.method === 'GET') {
        json(res, 200, { running: publications.status().running })
        return
      }
      if (auth.user.role !== 'admin') fail(403, 'Administrator required')
      if (url.pathname === '/account-api/settings' && req.method === 'GET') {
        json(res, 200, siteSettings())
        return
      }
      if (url.pathname === '/account-api/settings' && req.method === 'POST') {
        const body = await readJson(req)
        authorize()
        if (typeof body.proxyAllResources !== 'boolean') fail(400, 'proxyAllResources must be boolean')
        if (typeof body.onlineResourceEnabled !== 'boolean') fail(400, 'onlineResourceEnabled must be boolean')
        if (typeof body.ghMirrorHosts !== 'string' || body.ghMirrorHosts.length > 8192) fail(400, 'Invalid GitHub mirror list')
        const hosts = (body.ghMirrorHosts as string).split('\n').map((host) => host.trim()).filter(Boolean)
        for (const host of hosts) {
          try {
            const url = new URL(host)
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\s|,/.test(host))
              fail(400, 'Invalid GitHub mirror URL')
          } catch { fail(400, 'Invalid GitHub mirror URL') }
        }
        const ghMirrorHosts = formatExtensionGHMirrorHosts(hosts).join('\n')
        const enabled = body.proxyAllResources as boolean
        const onlineResourceEnabled = body.onlineResourceEnabled as boolean
        accounts.db.transaction(() => {
          accounts.setState('network.proxyAllResources', String(enabled))
          accounts.audit(auth.user.id, 'settings.proxyAllResources', String(enabled))
          accounts.setState('onlineResource.enable', String(onlineResourceEnabled))
          accounts.audit(auth.user.id, 'settings.onlineResourceEnabled', String(onlineResourceEnabled))
          accounts.setState('extension.ghMirrorHosts', ghMirrorHosts)
          accounts.audit(auth.user.id, 'settings.ghMirrorHosts')
        })()
        runtimes.setSiteSettings({ proxyAllResources: enabled, onlineResourceEnabled, ghMirrorHosts })
        json(res, 200, siteSettings())
        return
      }
      if (url.pathname === '/account-api/users' && req.method === 'GET') {
        json(res, 200, { users: accounts.list(), runtimes: runtimes.status() })
        return
      }
      if (url.pathname === '/account-api/users' && req.method === 'POST') {
        const body = await readJson(req)
        authorize()
        if (body.role === 'admin') fail(403, 'Administrator can only be created during deployment initialization')
        if (body.role !== undefined) fail(400, 'Account role cannot be specified')
        const user = await accounts.create(
          body.username as string,
          body.password as string,
          'user',
          auth.user.id,
          authorize
        )
        json(res, 201, { user: publicUser(user) })
        return
      }
      const userMatch = /^\/account-api\/users\/([^/]+)\/(disabled|password)$/.exec(url.pathname)
      if (userMatch && req.method === 'POST') {
        const body = await readJson(req),
          id = userMatch[1]
        authorize()
        if (userMatch[2] === 'disabled') {
          if (typeof body.disabled !== 'boolean') fail(400, 'disabled must be boolean')
          accounts.disable(id, body.disabled as boolean, auth.user.id)
        } else await accounts.password(id, body.password as string, auth.user.id, undefined, authorize)
        revoke(id)
        if (accounts.get(id)?.disabled) await runtimes.stop(id)
        json(res, 200, { ok: true })
        return
      }
      if (url.pathname === '/account-api/publication' && req.method === 'GET') {
        json(res, 200, publications.status())
        return
      }
      if (url.pathname === '/account-api/source-scripts' && req.method === 'GET') {
        if (publications.status().running) fail(409, 'Publication in progress')
        const runtime = await runtimes.get(auth.user)
        authorize()
        if (publications.status().running) fail(409, 'Publication in progress')
        const archive = await runtime.context.exportScripts!().catch((error: Error) => fail(400, error.message))
        authorize()
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="lx-sources.tar.gz"', 'Cache-Control': 'no-store' })
        res.end(archive)
        return
      }
      if (['/account-api/source-script', '/account-api/source-package', '/account-api/source-remote'].includes(url.pathname) && req.method === 'POST') {
        if (publications.status().running) fail(409, 'Publication in progress')
        const isPackage = url.pathname === '/account-api/source-package'
        const isRemote = url.pathname === '/account-api/source-remote'
        const remote = isRemote ? await readJson(req) : undefined
        const content = isRemote ? Buffer.alloc(0) : await readBody(req, (isPackage ? 16 : 1) * 1024 * 1024)
        authorize()
        const runtime = await runtimes.get(auth.user)
        authorize()
        if (publications.status().running) fail(409, 'Publication in progress')
        const fileName = url.searchParams.get('name') || 'source.js'
        if (fileName.length > 255) fail(400, 'Source filename is too long')
        const result = await (isRemote ? runtime.context.importRemoteScript!(remote!.url)
          : isPackage ? runtime.context.importPackage!(content) : runtime.context.importScript!(fileName, content.toString('utf8')))
          .catch((error: Error) => fail(400, error.message))
        json(res, 201, result)
        return
      }
      if (url.pathname === '/account-api/publication/retry' && req.method === 'POST') {
        await publications.retrySources()
        json(res, 200, publications.status())
        return
      }
      const retryMatch = /^\/account-api\/users\/([^/]+)\/retry$/.exec(url.pathname)
      if (retryMatch && req.method === 'POST') {
        const user = accounts.get(retryMatch[1])
        if (!user || user.disabled) fail(404, 'Active account not found')
        runtimes.retry(user!.id)
        if (runtimes.sources.status().error) await publications.retrySources()
        await runtimes.get(user!)
        json(res, 200, { ok: true })
        return
      }
      if (url.pathname === '/account-api/publication' && req.method === 'POST') {
        await publications.publish(auth.user)
        json(res, 200, publications.status())
        return
      }
      fail(404, 'Not found')
    }
    if (!url.pathname.startsWith('/u/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed')
      await serveStatic(req, res, decodeURIComponent(url.pathname).slice(1))
      return
    }
    const auth = authFor(req)
    if (!['GET', 'HEAD'].includes(req.method!) && req.headers.origin !== originFor(req)) fail(403, 'Invalid request origin')
    const target = userTarget(url, auth)
    const relative = target.split('?')[0].slice(1)
    // Serve only build assets here. Every runtime-created resource is routed through the owning process.
    if (!relative || (!relative.startsWith('api/') && !relative.startsWith('public/'))) {
      const file = path.resolve(publicDir, relative || 'index.html')
      if (file.startsWith(path.resolve(publicDir) + path.sep) && (await stat(file).catch(() => null))?.isFile()) {
        await serveStatic(req, res, relative)
        return
      }
    }
    const runtime = await runtimes.get(auth.user)
    if (req.destroyed || res.destroyed) return
    if (authFor(req).session.id !== auth.session.id) fail(401, 'Session expired')

    track(auth, res, runtime)
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: runtime.port,
        method: req.method,
        path: target,
        headers: forwardedHeaders(req, runtime, auth),
      },
      (response) => {
        const headers = {
          ...response.headers,
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
        }
        delete headers['set-cookie']
        res.writeHead(response.statusCode ?? 502, headers)
        response.on('error', () => res.destroy())
        response.pipe(res)
      }
    )
    upstream.on('error', () => {
      if (!res.headersSent) json(res, 502, { error: 'Account service unavailable' })
      else res.destroy()
    })
    req.on('aborted', () => upstream.destroy())
    res.once('close', () => upstream.destroy())
    req.pipe(upstream)
  }
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!(error instanceof AccountError) || error.status >= 500) logs.App.logcat.error('[Gateway] Request failed', error)
      if (res.headersSent || res.destroyed) {
        res.destroy()
        return
      }
      json(res, error instanceof AccountError ? error.status : 500, {
        error: error instanceof AccountError ? error.message : 'Request failed',
      })
    })
  })
  server.on('upgrade', (req, rawSocket, head) => {
    const socket = rawSocket as Socket
    socket.on('error', () => socket.destroy())
    void (async () => {
      if (req.headers.origin !== originFor(req)) fail(403, 'Invalid origin')
      const auth = authFor(req),
        url = new URL(req.url!, 'http://gateway')
      const target = userTarget(url, auth),
        runtime = await runtimes.get(auth.user)
      if (socket.destroyed) return
      if (authFor(req).session.id !== auth.session.id) fail(401, 'Session expired')

      track(auth, socket, runtime)
      const upstream = http.request({
        hostname: '127.0.0.1',
        port: runtime.port,
        path: target,
        headers: forwardedHeaders(req, runtime, auth),
      })
      upstream.on('upgrade', (response, backend, backendHead) => {
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
            .filter(([key]) => key !== 'set-cookie')
            .map(([key, value]) => `${key}: ${value}`)
            .join('\r\n')}\r\n\r\n`
        )
        if (backendHead.length) socket.write(backendHead)
        if (head.length) backend.write(head)
        backend.on('error', () => socket.destroy())
        backend.once('close', () => socket.destroy())
        socket.once('close', () => backend.destroy())
        socket.pipe(backend).pipe(socket)
      })
      upstream.on('response', (response) => {
        response.resume()
        socket.destroy()
      })
      upstream.on('error', () => socket.destroy())
      socket.once('close', () => upstream.destroy())
      upstream.end()
    })().catch(() => {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    })
  })
  const interval = setInterval(() => {
    void runtimes.reap().catch(() => {})
    for (const [id, entry] of connections) {
      const session = accounts.db.prepare('SELECT id FROM sessions WHERE id = ? AND expiresAt > ?').get(id, Date.now())
      if (!session) {
        for (const connection of entry.connections) connection.destroy()
        connections.delete(id)
      }
    }
  }, 15_000)
  interval.unref()
  let closing = false
  return {
    server,
    publications,
    async close() {
      if (closing) return
      closing = true
      await publications.close()
      clearInterval(interval)
      server.close()
      for (const entry of connections.values()) for (const connection of entry.connections) connection.destroy()
      try {
        await runtimes.close()
      } finally {
        accounts.close()
      }
    },
  }
}
