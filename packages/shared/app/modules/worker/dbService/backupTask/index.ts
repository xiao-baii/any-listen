import path from 'node:path'

import type Database from 'better-sqlite3'

import { requestBackupEvent } from '../event'
import { queryMetadataLastBackupTime, saveMetadataLastBackupTime } from '../modules/metadata/backupTime'
import { EVENT_BACKUP_THROTTLE_MS } from './constants'
import { createTempBackupPath, formatBackupTimestamp, resolveBackupPathInfo, resolveBackupType } from './naming'
import { isSameDay, scheduleDailyBackup } from './scheduler'
import {
  ensureDir,
  ensureUniqueBackupPath,
  hashFileSha256,
  listBackupFiles,
  moveFile,
  pruneDailyBackups,
  pruneEventBackups,
  removeFileIfExists,
} from './storage'
import type { BackupTrigger } from './types'

let currentBackupTask: Promise<boolean> | null = null
let isInited = false

const backup = async (db: Database.Database, trigger: BackupTrigger): Promise<boolean> => {
  if (process.env.ANYLISTEN_USER_ID) return false
  if (currentBackupTask) return false

  const backupType = resolveBackupType(trigger)
  const isDailyBackup = backupType == 'daily'

  const task = (async () => {
    const info = await resolveBackupPathInfo(db, backupType)
    if (!info) return false
    const tempPath = createTempBackupPath(info.filePath)

    try {
      await ensureDir(info.dir)
      const files = await listBackupFiles(info.dir, info.prefix)
      const latestFile = files[0] ? path.join(info.dir, files[0]) : null

      await db.backup(tempPath)

      if (latestFile) {
        const [latestHash, tempHash] = await Promise.all([hashFileSha256(latestFile), hashFileSha256(tempPath)])
        if (latestHash == tempHash) {
          await removeFileIfExists(tempPath)
          if (isDailyBackup) saveMetadataLastBackupTime(Date.now())
          return false
        }
      }

      const backupPath = await ensureUniqueBackupPath(info.filePath, formatBackupTimestamp(Date.now()))
      await moveFile(tempPath, backupPath)
      if (isDailyBackup) {
        await pruneDailyBackups(info.dir, info.prefix)
        saveMetadataLastBackupTime(Date.now())
      } else {
        await pruneEventBackups(info.dir, info.prefix)
      }
      return true
    } catch (error) {
      console.error('[dbService] backup failed', trigger, error)
      return false
    } finally {
      await removeFileIfExists(tempPath)
      currentBackupTask = null
    }
  })()

  currentBackupTask = task
  return task
}

export const breakChangeBackup = async (db: Database.Database) => {
  if (currentBackupTask) {
    await currentBackupTask
    return
  }
  await backup(db, 'event')
}

const runBackupTask = async (db: Database.Database) => {
  const lastBackupTime = queryMetadataLastBackupTime()
  if (!isSameDay(lastBackupTime, Date.now())) {
    await backup(db, 'init')
  }

  scheduleDailyBackup(async () => {
    await backup(db, 'interval')
  })
}

const setupEventBackupTrigger = (db: Database.Database) => {
  let timer: NodeJS.Timeout | null = null
  let lastRunTime = 0

  const runBackup = () => {
    if (timer) clearTimeout(timer)
    if (currentBackupTask) return

    const now = performance.now()
    const restTime = EVENT_BACKUP_THROTTLE_MS - (now - lastRunTime)
    if (restTime > 0) {
      timer = setTimeout(() => {
        timer = null
        lastRunTime = performance.now()
        void backup(db, 'event')
      }, restTime)
      return
    }

    lastRunTime = now
    void backup(db, 'event')
  }

  requestBackupEvent.on(runBackup)
}

export const initBackupTask = async (db: Database.Database) => {
  if (process.env.ANYLISTEN_USER_ID) return
  if (isInited) return
  isInited = true

  setupEventBackupTrigger(db)
  await runBackupTask(db)
}

// export const setBackupPath = (backupPath: string) => {}
export { initBackupPath, setBackupPath } from './naming'
