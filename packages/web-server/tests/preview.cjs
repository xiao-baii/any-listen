const path = require('node:path')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '../../..')
const scriptsRequire = createRequire(path.join(root, 'packages/shared/scripts/package.json'))
async function main() {
  const output = path.join(root, 'work/preview-bootstrap.cjs')
  await scriptsRequire('esbuild').build({
    stdin: {
      contents: `
    import { Accounts } from './packages/web-server/src/accounts/database';
    import { getNativeName } from './packages/shared/nodejs';
    const accounts = new Accounts(process.env.DATA_PATH!, require('node:path').join(process.cwd(), 'build/native', getNativeName(), 'better_sqlite3.node'));
    async function main() {
      for (const username of ['preview-admin', 'preview-user']) {
        if (!accounts.find(username)) {
          const user = await accounts.create(username, 'Preview-local-12345', username === 'preview-admin' ? 'admin' : 'user', null);
          await accounts.password(user.id, 'Preview-local-12345', false, user.id);
        }
      }
      accounts.close();
      require('../build/server/accounts.js');
    }
    void main();
  `,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: output,
    external: ['../build/server/accounts.js'],
  })
  process.env.DATA_PATH = path.join(root, 'work/preview-data')
  process.env.PORT = '9510'
  process.env.BIND_IP = '127.0.0.1'
  process.env.PUBLIC_ORIGIN = 'http://localhost:9510'
  require(output)
}
main().catch(console.error)
