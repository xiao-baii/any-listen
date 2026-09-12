import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

import { Agent, buildConnector } from 'undici'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6')

export const isPublicAddress = (address: string) => {
  const family = isIP(address)
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

// Validate at connection time and connect to that exact IP: redirects and DNS changes cannot bypass the check.
export const publicNetworkAgent = (allowedOrigins: string[] = []) => {
  const allowed = new Set(allowedOrigins.map((origin) => new URL(origin).origin))
  const connect = buildConnector({ timeout: 10_000 })
  return new Agent({
    connect(options, callback) {
      void (async () => {
        if (options.httpSocket || options.socketPath) throw new Error('Unsupported outbound socket')
        const hostname = options.hostname.replace(/^\[|\]$/g, '')
        const origin = new URL(
          `${options.protocol}//${isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${options.port || (options.protocol === 'https:' ? 443 : 80)}`
        ).origin
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true })
        if (!addresses.length || (!allowed.has(origin) && addresses.some(({ address }) => !isPublicAddress(address))))
          throw new Error('Private network destinations are not allowed')
        connect(
          {
            ...options,
            hostname: addresses[0].address,
            servername: options.servername || (isIP(hostname) ? undefined : hostname),
          },
          callback
        )
      })().catch((error: Error) => callback(error, null))
    },
  })
}
