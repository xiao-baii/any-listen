const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')
const { rmSync } = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../../..')
const scriptsRequire = createRequire(path.join(root, 'packages/shared/scripts/package.json'))
const output = path.join(__dirname, '.memory.generated.cjs')

async function main() {
  await scriptsRequire('esbuild').build({
    entryPoints: [path.join(__dirname, 'memory.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: output,
    external: ['better-sqlite3', 'ws'], tsconfig: path.join(__dirname, '../tsconfig.json'),
    define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.VITE_IS_DESKTOP': 'false', 'import.meta.env.VITE_IS_WINDOWS_LEGACY': 'false',
      '__GIT_COMMIT__': '""', '__GIT_COMMIT_DATE__': '""' },
    plugins: process.env.ACCOUNT_BASELINE_ROOT ? [{ name: 'baseline-runtime', setup(build) {
      build.onResolve({ filter: /^\.\.\/src\/accounts\/runtime$/ }, () => ({
        path: path.resolve(process.env.ACCOUNT_BASELINE_ROOT, 'packages/web-server/src/accounts/runtime.ts'),
      }))
    } }] : [],
  })
  const result = spawnSync(process.execPath, ['--expose-gc', output], {
    stdio: 'inherit', env: { ...process.env, ACCOUNT_TEST_ROOT: root },
  })
  process.exitCode = result.status ?? 1
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => rmSync(output, { force: true }))
