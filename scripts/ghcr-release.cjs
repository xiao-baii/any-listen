const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { appendFileSync } = require('node:fs')

const repository = 'xiao-baii/any-listen'
const image = `ghcr.io/${repository}`
const mediaTypes = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]
const versionPattern = /^multi-user-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function isRelease(tag) {
  return versionPattern.test(tag)
}

function isNewer(tag, previous) {
  assert(isRelease(tag) && isRelease(previous), 'Invalid release version')
  const current = tag.match(versionPattern).slice(1).map(BigInt)
  const old = previous.match(versionPattern).slice(1).map(BigInt)
  for (let i = 0; i < 3; i++) {
    if (current[i] !== old[i]) return current[i] > old[i]
  }
  return false
}

async function connect(env, request = fetch) {
  const auth = Buffer.from(`${env.GITHUB_ACTOR}:${env.GITHUB_TOKEN}`).toString('base64')
  const response = await request(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull,push`, {
    headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(30_000),
  })
  assert(response.ok, `GHCR authentication failed: ${response.status}`)
  const { token } = await response.json()
  assert(token, 'GHCR did not return a token')

  async function call(path, options = {}) {
    return request(`https://ghcr.io/v2/${repository}/${path}`, {
      ...options, signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: mediaTypes.join(', '), ...options.headers },
    })
  }

  async function read(path, optional = false) {
    const res = await call(path)
    if (optional && res.status === 404) {
      const { errors } = await res.json()
      if (errors?.length && errors.every(({ code }) => ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'].includes(code))) return null
    }
    assert(res.ok, `GHCR read failed (${path}): ${res.status}`)
    const raw = await res.text()
    const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`
    const expected = path.split('/').at(-1)
    if (expected.startsWith('sha256:')) assert.equal(digest, expected, 'GHCR content digest mismatch')
    const header = res.headers.get('docker-content-digest')
    if (header) assert.equal(digest, header, 'GHCR response digest mismatch')
    return { raw, digest, data: JSON.parse(raw) }
  }

  return {
    manifest: (tag) => read(`manifests/${tag}`, true),
    async config(manifest) {
      let { data } = manifest
      if (data.manifests) {
        const runtime = data.manifests.filter(({ platform }) => platform?.os !== 'unknown')
        assert.equal(runtime.length, 1, 'Expected one runtime platform')
        assert.equal(runtime[0].platform.os, 'linux')
        assert.equal(runtime[0].platform.architecture, 'amd64')
        data = (await read(`manifests/${runtime[0].digest}`)).data
      }
      const config = (await read(`blobs/${data.config.digest}`)).data
      assert.equal(config.os, 'linux')
      assert.equal(config.architecture, 'amd64')
      return config.config.Labels
    },
    async tag(name, manifest) {
      assert.equal(name, 'multi-user', 'Only the rolling tag may be written')
      assert(mediaTypes.includes(manifest.data.mediaType), 'Unsupported manifest media type')
      const res = await call(`manifests/${name}`, {
        method: 'PUT', headers: { 'Content-Type': manifest.data.mediaType }, body: manifest.raw,
      })
      assert.equal(res.status, 201, `GHCR tag update failed: ${res.status}`)
    },
  }
}

async function release(registry, phase, tag, sha, expectedDigest) {
  assert(isRelease(tag), 'Only multi-user-vX.Y.Z releases may publish')
  assert(/^[a-f0-9]{40}$/.test(sha), 'Invalid commit SHA')
  const fixed = await registry.manifest(tag)
  const commit = await registry.manifest(`sha-${sha}`)
  if (!fixed) {
    assert.equal(phase, 'prepare', 'Published version tag is missing')
    assert(!commit, 'Commit tag already exists; release a new commit instead of overwriting it')
    return { build: true }
  }
  const labels = await registry.config(fixed)
  if (expectedDigest) assert.equal(fixed.digest, expectedDigest, 'Published digest differs from build output')
  assert.equal(labels['org.opencontainers.image.version'], tag, 'Version tag already belongs to another release')
  assert.equal(labels['org.opencontainers.image.revision'], sha, 'Version tag already belongs to another commit')
  assert(commit, 'Commit tag missing; inspect the partial publication before retrying')
  assert.equal(commit.digest, fixed.digest, 'Version and commit tags differ')
  if (phase === 'prepare') return { build: false, digest: fixed.digest }

  const previous = await registry.manifest('multi-user')
  let promote = !previous
  if (previous) {
    const old = await registry.config(previous)
    const oldVersion = old['org.opencontainers.image.version']
    assert(isRelease(oldVersion), 'Rolling tag lacks a valid release version; inspect it before publishing')
    if (oldVersion === tag) assert.equal(previous.digest, fixed.digest, 'Rolling tag conflicts with fixed version')
    promote = isNewer(tag, oldVersion)
  }
  if (promote) {
    await registry.tag('multi-user', fixed)
    assert.equal((await registry.manifest('multi-user'))?.digest, fixed.digest, 'Rolling tag verification failed')
  }
  return { build: false, digest: fixed.digest, promoted: promote }
}

async function main() {
  const env = process.env
  const phase = process.argv[2]
  assert(['prepare', 'publish'].includes(phase), 'Expected prepare or publish')
  assert.equal(env.GITHUB_REPOSITORY, repository)
  assert.equal(env.GITHUB_EVENT_NAME, 'push')
  assert.equal(env.GITHUB_REF_TYPE, 'tag')
  assert(env.GITHUB_TOKEN && env.GITHUB_ACTOR, 'Missing registry credentials')
  const result = await release(await connect(env), phase, env.GITHUB_REF_NAME, env.GITHUB_SHA, env.EXPECTED_DIGEST)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `build=${result.build}\n`)
  if (phase === 'publish' && env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `Published ${image}:${env.GITHUB_REF_NAME}\n\nDigest: ${result.digest}\n\nRolling tag advanced: ${result.promoted}\n\nFirst publication: set the GHCR package visibility to public, then verify an anonymous pull.\n`)
  }
  console.log(JSON.stringify(result))
}

module.exports = { isRelease, isNewer, connect, release }
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1 })
