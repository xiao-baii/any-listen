const { createRequire } = require('node:module')
const path = require('node:path')
const scriptsRequire = createRequire(path.resolve(__dirname, '../../packages/shared/scripts/package.json'))
scriptsRequire('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: { module: 'Node16', moduleResolution: 'Node16' },
})
require('./verify-agent-note-tree.ts')
require('./verify-agent-note-format.ts')
require('./verify-archived-agent-notes.ts')
