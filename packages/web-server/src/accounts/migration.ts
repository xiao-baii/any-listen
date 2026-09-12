import { mkdir, readFile, readdir, rename, writeFile, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

import Database from 'better-sqlite3'

import type { Accounts } from './database'
import { safeCopy } from './publications'

export const migrate = async (accounts: Accounts, root: string, userId: string, sourceInput: string, nativeBinding?: string) => {
  const source = await realpath(sourceInput)
  const resolvedRoot = await realpath(root)
  if (source === resolvedRoot || source.startsWith(resolvedRoot + path.sep) || resolvedRoot.startsWith(source + path.sep))
    throw new Error('Old and new data directories must be separate')
  const key = `migration:${userId}`
  if (accounts.state(key) === 'complete') {
    console.log('Migration already completed')
    return
  }
  const target = path.join(root, 'users', userId)
  if (await lstat(target).catch(() => null)) {
    const report = await readFile(path.join(target, 'migration-report.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    if (report?.source === source && ['copying', 'failed'].includes(accounts.state(key) ?? '')) {
      accounts.setState(key, 'complete')
      return
    }
    throw new Error('Target account already contains data. Migrate before first playback login.')
  }
  const staging = path.join(root, 'migration', userId)
  const backup = path.join(root, 'legacy-backups', userId)
  if (await lstat(staging).catch(() => null))
    throw new Error('An incomplete migration exists; inspect the migration report before retrying with a clean destination')
  await mkdir(staging, { recursive: true })
  accounts.setState(key, 'copying')
  const warnings: string[] = []
  try {
    if (await lstat(backup).catch(() => null))
      throw new Error('Backup already exists; preserve it and use a fresh migration destination')
    await safeCopy(source, backup)
    await safeCopy(path.join(backup, 'app'), path.join(staging, 'app'))
    for (const dir of ['cache']) {
      if (await lstat(path.join(backup, dir)).catch(() => null)) await safeCopy(path.join(backup, dir), path.join(staging, dir))
    }
    const walk = async (dir: string) => {
      for (const name of await readdir(dir)) {
        const file = path.join(dir, name),
          info = await lstat(file)
        if (info.isDirectory()) await walk(file)
        else if (/\.(db|sqlite|sqlite3)$/.test(name)) {
          const db = new Database(file, { readonly: true, ...(nativeBinding ? { nativeBinding } : {}) })
          try {
            const integrity = db.pragma('integrity_check', { simple: true })
            if (integrity !== 'ok') throw new Error(`Database integrity check failed: ${name}`)
            const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
              name: string
            }[]
            for (const table of tables)
              for (const row of db.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`).iterate()) inspectValues(row)
          } finally {
            db.close()
          }
        } else if (name.endsWith('.json')) inspectValues(JSON.parse(await readFile(file, 'utf8')))
      }
    }
    const inspectValues = (value: unknown) => {
      if (typeof value === 'string' && (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)))
        warnings.push(`Review absolute path: ${value}`)
      else if (value && typeof value === 'object') for (const item of Object.values(value)) inspectValues(item)
      else if (typeof value === 'string' && /^[\[{]/.test(value)) {
        try {
          inspectValues(JSON.parse(value))
        } catch {}
      }
    }
    await walk(path.join(staging, 'app'))
    const absolutePaths = await Promise.all(
      [...new Set(warnings)].map(async (warning) => {
        const filePath = warning.slice('Review absolute path: '.length)
        return { path: filePath, existsOnMigrationHost: Boolean(await lstat(filePath).catch(() => null)) }
      })
    )
    await writeFile(
      path.join(staging, 'migration-report.json'),
      JSON.stringify({ source, backup, warnings: [...new Set(warnings)], absolutePaths, tokensInvalidated: true }, null, 2)
    )
    await mkdir(path.dirname(target), { recursive: true })
    await rename(staging, target)
    accounts.setState(key, 'complete')
    accounts.audit(userId, 'migration.complete', userId)
    console.log(`Migration completed. Review ${path.join(target, 'migration-report.json')}`)
  } catch (error) {
    accounts.setState(key, 'failed')
    await writeFile(path.join(staging, 'failure.json'), JSON.stringify({ error: (error as Error).message }))
    throw error
  }
}
