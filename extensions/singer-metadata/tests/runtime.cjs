const { createRequire } = require('node:module')
const { createHash } = require('node:crypto')
const vm = require('node:vm')
const path = require('node:path')
const scripts = createRequire(path.resolve(__dirname, '../../../packages/shared/scripts/package.json'))
exports.load = async request => {
  let actions
  const { outputFiles } = await scripts('esbuild').build({ entryPoints: [path.join(__dirname, '../src/index.cjs')], bundle: true, platform: 'neutral', format: 'cjs', external: ['any-listen'], write: false })
  vm.runInNewContext(outputFiles[0].text, {
    require(name) {
      if (name !== 'any-listen') throw new Error(`Unexpected module ${name}`)
      return { request, utils: { crypto: { md5: async text => createHash('md5').update(text).digest('hex') } }, registerResourceAction: value => { actions = value } }
    },
  })
  return actions
}
exports.request = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  return { statusCode: response.status, body: await response.text() }
}
