const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const vm = require('node:vm')

const { transformSync } = createRequire(path.resolve(__dirname, '../../shared/scripts/package.json'))('esbuild')
const ts = createRequire(path.resolve(__dirname, '../../shared/eslint/package.json'))('typescript')
const readSource = (file) => readFileSync(path.resolve(__dirname, '../src', file), 'utf8')
const parseScript = (file) => {
  const script = readSource(file).match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
  return ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function load(source, modules, globals = {}) {
  const module = { exports: {} }
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' })
  const context = Object.defineProperties(
    { module, require: (name) => modules[name] ?? {} },
    Object.getOwnPropertyDescriptors(globals)
  )
  vm.runInNewContext(code, context)
  return module.exports
}

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

module.exports = { deferred, load, parseScript, readSource, ts }
