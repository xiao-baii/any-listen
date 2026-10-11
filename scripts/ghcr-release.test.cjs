const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { test } = require('node:test')
const { isRelease, isNewer, connect, release } = require('./ghcr-release.cjs')

const sha = 'a'.repeat(40)
const tag = 'multi-user-v1.10.0'
function registry(previous) {
  const tags = new Map()
  const writes = []
  function add(name, version, revision = sha, digest = version) {
    tags.set(name, { digest, labels: { 'org.opencontainers.image.version': version, 'org.opencontainers.image.revision': revision } })
  }
  if (previous) add('multi-user', previous)
  return {
    tags, writes, add,
    manifest: async (name) => tags.get(name) ?? null,
    config: async (manifest) => manifest.labels,
    tag: async (name, manifest) => { writes.push(name); tags.set(name, manifest) },
  }
}
function published(previous) {
  const remote = registry(previous)
  remote.add(tag, tag)
  remote.add(`sha-${sha}`, tag)
  return remote
}

test('only canonical stable tags qualify; numeric ordering handles multi-digit and large versions', () => {
  for (const name of ['multi-user', 'v1.2.3', 'multi-user-v1.2', 'multi-user-v01.2.3', 'multi-user-v1.2.3-rc.1', 'multi-user-v1.2.3+build']) assert(!isRelease(name))
  assert(isRelease('multi-user-v0.0.0'))
  assert(isNewer(tag, 'multi-user-v1.9.99'))
  assert(!isNewer(tag, tag))
  assert(!isNewer(tag, 'multi-user-v2.0.0'))
  assert(isNewer('multi-user-v9007199254740993.0.0', 'multi-user-v9007199254740992.0.0'))
})

test('first release builds; retries reuse the existing image without overwriting fixed tags', async () => {
  assert.deepEqual(await release(registry(), 'prepare', tag, sha), { build: true })
  const remote = published()
  assert.equal((await release(remote, 'prepare', tag, sha)).build, false)
  assert.equal((await release(remote, 'publish', tag, sha)).promoted, true)
  assert.equal((await release(remote, 'publish', tag, sha)).promoted, false)
  assert.deepEqual(remote.writes, ['multi-user'])
})

test('late older releases never downgrade the rolling tag; newer ones advance it', async () => {
  const newer = published('multi-user-v1.9.9')
  assert.equal((await release(newer, 'publish', tag, sha)).promoted, true)
  const older = published('multi-user-v2.0.0')
  assert.equal((await release(older, 'publish', tag, sha)).promoted, false)
  assert.deepEqual(older.writes, [])
})

test('conflicting and partial fixed tags block publishing', async () => {
  const remote = published()
  await assert.rejects(release(remote, 'prepare', tag, 'b'.repeat(40)), /another commit/)
  remote.tags.delete(tag)
  await assert.rejects(release(remote, 'prepare', tag, sha), /Commit tag already exists/)
  remote.add(tag, tag)
  remote.tags.delete(`sha-${sha}`)
  await assert.rejects(release(remote, 'prepare', tag, sha), /Commit tag missing/)
  remote.add(`sha-${sha}`, tag, sha, 'different digest')
  await assert.rejects(release(remote, 'publish', tag, sha), /tags differ/)
  assert.deepEqual(remote.writes, [])
})

test('invalid or conflicting rolling metadata fails closed', async () => {
  const remote = published('multi-user-v1.2.3-beta.1')
  await assert.rejects(release(remote, 'publish', tag, sha), /valid release version/)
  remote.add('multi-user', tag, sha, 'different digest')
  await assert.rejects(release(remote, 'publish', tag, sha), /conflicts/)
  assert.deepEqual(remote.writes, [])
})

test('build digest mismatch or missing published image never advances the rolling tag', async () => {
  const remote = published()
  await assert.rejects(release(remote, 'publish', tag, sha, 'unexpected digest'), /differs from build/)
  await assert.rejects(release(registry(), 'publish', tag, sha), /Published version tag is missing/)
  await assert.rejects(release(remote, 'publish', `${tag}-rc.1`, sha), /Only multi-user/)
  remote.tags.delete('multi-user')
  remote.tag = async () => {}
  await assert.rejects(release(remote, 'publish', tag, sha), /Rolling tag verification failed/)
  assert.deepEqual(remote.writes, [])
})

function mockFetch(reply) {
  return async (url, options) => url.includes('/token?')
    ? Response.json({ token: 'test-token' }) : reply(url, options)
}

test('only explicit registry not-found errors mean a tag is absent', async () => {
  for (const status of [401, 403, 429, 500]) {
    const remote = await connect({}, mockFetch(() => new Response('', { status })))
    await assert.rejects(remote.manifest(tag), /GHCR read failed/)
  }
  for (const code of ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN']) {
    const remote = await connect({}, mockFetch(() => Response.json({ errors: [{ code }] }, { status: 404 })))
    assert.equal(await remote.manifest(tag), null)
  }
  const remote = await connect({}, mockFetch(() => Response.json({ errors: [{ code: 'DENIED' }] }, { status: 404 })))
  await assert.rejects(remote.manifest(tag), /GHCR read failed/)
  await assert.rejects(connect({}, async () => new Response('', { status: 403 })), /authentication failed/)
})

test('registry verifies content hashes and linux/amd64 config, including attestation indexes', async () => {
  for (const architecture of ['amd64', 'arm64']) {
    const config = JSON.stringify({ os: 'linux', architecture, config: { Labels: { version: tag } } })
    const hash = (raw) => `sha256:${createHash('sha256').update(raw).digest('hex')}`
    const manifest = JSON.stringify({ config: { digest: hash(config) } })
    const remote = await connect({}, mockFetch((url) => new Response(url.includes('/blobs/') ? config : manifest)))
    const index = { data: { manifests: [
      { digest: hash(manifest), platform: { os: 'linux', architecture: 'amd64' } },
      { platform: { os: 'unknown', architecture: 'unknown' } },
    ] } }
    if (architecture === 'amd64') assert.deepEqual(await remote.config(index), { version: tag })
    else await assert.rejects(remote.config(index))
    await assert.rejects(remote.config({ data: { config: { digest: `sha256:${'0'.repeat(64)}` } } }), /digest mismatch/)
  }
})

test('rolling tag writes preserve the manifest bytes and cannot write fixed tags', async () => {
  let written
  const remote = await connect({}, mockFetch((url, options) => {
    written = { url, ...options }
    return new Response(null, { status: 201 })
  }))
  const data = { mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] }
  const manifest = { data, raw: JSON.stringify(data) }
  await remote.tag('multi-user', manifest)
  assert.equal(written.body, manifest.raw)
  assert.equal(written.method, 'PUT')
  assert.equal(written.headers['Content-Type'], data.mediaType)
  await assert.rejects(remote.tag(tag, manifest), /Only the rolling tag/)
})
