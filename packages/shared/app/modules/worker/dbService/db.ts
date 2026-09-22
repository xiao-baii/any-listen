import path from 'node:path'

import { DB_NAME, LIST_IDS } from '@any-listen/common/constants'
import { removeDB, getDefaultAutoBackupPath } from '@any-listen/nodejs/tools'
import Database from 'better-sqlite3'

import { initBackupTask, initBackupPath } from './backupTask'
import migrateData from './migrate'
import tables, { DB_VERSION } from './tables'
import verifyDB from './verifyDB'
import { getDatabaseContext } from './context'

const initTables = (db: Database.Database) => {
  let now = Date.now()
  let defaultMetadata = `{"playCount":0,"playTime":0,"createTime":${now},"updateTime":0,"posTime":0}`
  db.exec(`
    ${Array.from(tables.values()).join('\n')}
    INSERT INTO "main"."metadata" ("field_name", "field_value") VALUES
      ('db_version', '${DB_VERSION}'),
      ('play_count', '0'),
      ('play_time', '0');
    INSERT INTO "main"."my_list" ("id", "name", "type", "parent_id", "meta", "position") VALUES
      ('${LIST_IDS.DEFAULT}', 'default', '${LIST_IDS.DEFAULT}', null, '${defaultMetadata}', 0),
      ('${LIST_IDS.LOVE}', 'love', '${LIST_IDS.DEFAULT}', null, '${defaultMetadata}', 0),
      ('${LIST_IDS.LAST_PLAYED}', 'last_played', '${LIST_IDS.DEFAULT}', null, '${defaultMetadata}', 0);
  `)
}

export const backupDB = async (dataPath: string, nativeBindingPath: string, backupPath: string) => {
  const databasePath = path.join(dataPath, DB_NAME)
  const nativeBinding = path.resolve(__dirname, nativeBindingPath)
  const db = new Database(databasePath, { nativeBinding })
  await db.backup(backupPath)
  db.close()
  await removeDB(dataPath)
}

// 打开、初始化数据库
export const init = async (
  dataPath: string,
  nativeBindingPath: string,
  machineId: string,
  backupPath?: string
): Promise<boolean | null> => {
  const context = getDatabaseContext()
  if (context.db?.open) throw new Error('Database is already initialized')
  let db: Database.Database
  const databasePath = path.join(dataPath, DB_NAME)
  const nativeBinding = path.resolve(__dirname, nativeBindingPath)
  let dbFileExists = true

  try {
    db = new Database(databasePath, {
      fileMustExist: true,
      nativeBinding,
      // verbose: process.env.NODE_ENV !== 'production' ? console.log : undefined,
    })
  } catch (error) {
    if (!context.managed) console.log(error)
    db = new Database(databasePath, {
      nativeBinding,
      // verbose: process.env.NODE_ENV !== 'production' ? console.log : undefined,
    })
    initTables(db)
    dbFileExists = false
  }
  context.db = db
  db.pragma('journal_mode = WAL')

  if (dbFileExists) migrateData(db, machineId)

  // https://www.sqlite.org/pragma.html#pragma_optimize
  // TODO: Scheduled exec, backup
  if (dbFileExists) db.exec('PRAGMA optimize;')
  if (!verifyDB(db)) {
    db.close()
    return null
  }
  if (!context.managed) {
    initBackupPath(getDefaultAutoBackupPath(dataPath), backupPath || '')
    await initBackupTask(db)
  }

  // https://www.sqlite.org/lang_vacuum.html
  // db.exec('VACUUM "main"')

  if (!context.managed) process.once('exit', () => { if (db.open) db.close() })
  // require('./test')
  return dbFileExists
}

// 获取数据库实例
export const getDB = (): Database.Database => {
  const db = getDatabaseContext().db
  if (!db?.open) throw new Error('Database is not initialized')
  return db
}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const dbPrepare = <T extends {} | unknown[] = [], R = undefined>(sql: string) => {
  return getDB().prepare<T, R>(sql)
}
