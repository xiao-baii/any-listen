import { DatabaseContext } from './context'
import { init } from './db'
import * as dislike_list from './modules/dislike_list'
import * as lyric from './modules/lyric'
import * as metadata from './modules/metadata'
import * as music_library from './modules/music_library'
import * as music_other_source from './modules/music_other_source'
import * as music_url from './modules/music_url'
import * as play_count from './modules/play_count'
import * as play_list from './modules/play_list'

const actions = {
  ...metadata,
  ...play_list,
  ...music_library,
  ...lyric,
  ...music_url,
  ...music_other_source,
  ...dislike_list,
  ...play_count,
  breakChangeBackup: async () => {},
}
export type AccountDatabaseActions = typeof actions

export const createAccountDatabase = async (dataPath: string, nativeBindingPath: string, machineId: string) => {
  const context = new DatabaseContext(true)
  try {
    const result = await context.run(() => init(dataPath, nativeBindingPath, machineId))
    if (result === null) throw new Error('Account database integrity check failed')
  } catch (error) {
    context.close()
    throw error
  }
  const service = Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [
      name,
      (...args: unknown[]) => {
        return context.run(() => {
          try {
            return (action as (...args: unknown[]) => unknown)(...args)
          } finally {
            // Trim after mutations finish so intermediate array references remain valid.
            music_library.trimMusicListCache()
          }
        })
      },
    ])
  ) as AccountDatabaseActions
  return { service, close: () => context.close() }
}
