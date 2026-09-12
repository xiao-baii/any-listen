import { readFile } from 'node:fs/promises'

import type { Accounts } from './database'

export const initializeAdmin = async (accounts: Accounts, env: NodeJS.ProcessEnv = process.env) => {
  try {
    if (accounts.list().length) return
    const username = env.ADMIN_USERNAME
    const passwordFile = env.ADMIN_PASSWORD_FILE
    if (!username || (!env.ADMIN_PASSWORD && !passwordFile))
      throw new Error('First startup requires ADMIN_USERNAME and ADMIN_PASSWORD (or ADMIN_PASSWORD_FILE)')
    if (env.ADMIN_PASSWORD && passwordFile) throw new Error('Set only one of ADMIN_PASSWORD and ADMIN_PASSWORD_FILE')
    const password = passwordFile ? (await readFile(passwordFile, 'utf8')).trimEnd() : env.ADMIN_PASSWORD!
    const user = await accounts.create(username, password, 'admin', null)
    console.log(`Administrator created: ${user.username} (${user.id}). Password change required on first login.`)
  } finally {
    delete env.ADMIN_PASSWORD
    delete env.ADMIN_PASSWORD_FILE
  }
}
