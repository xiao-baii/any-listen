import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { getNativeName } from '@any-listen/nodejs'

import { initializeAdmin } from './bootstrap'
import { Accounts } from './database'
import { createGateway } from './gateway'
import { migrate } from './migration'
import { Runtimes } from './runtime'

const main = async () => {
  const root = path.resolve(process.env.DATA_PATH ?? path.join(__dirname, '../data'))
  const binding = path.join(__dirname, '../native', getNativeName(), 'better_sqlite3.node')
  const accounts = new Accounts(root, binding)
  const [command, username, source] = process.argv.slice(2)
  if (command === 'create-admin') {
    if (accounts.list().some((u) => u.role === 'admin')) throw new Error('Administrator already exists')
    const passwordFile = process.env.ADMIN_PASSWORD_FILE
    if (!passwordFile) throw new Error('Set ADMIN_PASSWORD_FILE to a file containing the initial password')
    const user = await accounts.create(username, (await readFile(passwordFile, 'utf8')).trimEnd(), 'admin', null)
    console.log(`Administrator created: ${user.username} (${user.id}).`)
    accounts.close()
    return
  }
  if (command === 'migrate') {
    const user = accounts.find(username)
    if (!user || user.role !== 'admin' || !source) throw new Error('Usage: migrate ADMIN_USERNAME OLD_DATA_DIRECTORY')
    await migrate(accounts, root, user.id, source, binding)
    accounts.close()
    return
  }
  try {
    await initializeAdmin(accounts)
  } catch (error) {
    accounts.close()
    throw error
  }
  await mkdir(path.join(root, 'users'), { recursive: true })
  const runtimes = new Runtimes(root, path.join(__dirname, 'index.js'), Number(process.env.ACCOUNT_IDLE_MS ?? 300_000))
  const gateway = createGateway(accounts, runtimes, path.join(__dirname, '../public'), process.env.PUBLIC_ORIGIN)
  gateway.server.listen(Number(process.env.PORT ?? 9500), process.env.BIND_IP ?? '0.0.0.0', () =>
    console.log('Any Listen account gateway listening')
  )
  const stop = () => {
    void gateway
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(error)
        process.exit(1)
      })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
void main().catch((error: unknown) => {
  console.error((error as Error).message)
  process.exitCode = 1
})
