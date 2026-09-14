const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const scriptsRequire = createRequire(path.resolve(__dirname, '../../shared/scripts/package.json'))
const out = path.join(__dirname, '.generated')
async function main() {
  const testFile = process.argv[2] ?? 'accounts.test.ts'
  if (!['accounts.test.ts', 'extensions.test.ts', 'database.test.ts', 'sharedSources.test.ts', 'player.test.ts', 'musicList.test.ts'].includes(testFile)) throw new Error('Unknown test file')
  if (testFile === 'database.test.ts') {
    await scriptsRequire('esbuild').build({
      entryPoints: [path.join(__dirname, '../src/accounts/database.worker.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(out, 'database.worker.cjs'),
      external: ['better-sqlite3'],
      tsconfig: path.join(__dirname, '../tsconfig.json'),
    })
  }
  await scriptsRequire('esbuild').build({
    entryPoints: [path.join(__dirname, testFile)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(out, 'accounts.test.cjs'),
    external: ['better-sqlite3', 'ws'],
    tsconfig: path.join(__dirname, '../tsconfig.json'),
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.VITE_IS_DESKTOP': 'false', '__GIT_COMMIT__': '""', '__GIT_COMMIT_DATE__': '""' },
  })
  const result = spawnSync(process.execPath, ['--test', path.join(out, 'accounts.test.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, ACCOUNT_TEST_ROOT: path.resolve(__dirname, '../../..') },
  })
  process.exitCode = result.status ?? 1
}
main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => fs.rmSync(out, { recursive: true, force: true }))
