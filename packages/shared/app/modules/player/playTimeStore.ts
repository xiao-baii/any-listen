import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { STORE_NAMES } from '@any-listen/common/constants'

export const createPlayTimeStore = (getDataPath: () => string) => {
  let time = 0
  let loading: Promise<void> | undefined
  let writing = Promise.resolve()
  const file = () => {
    const directory = getDataPath()
    if (!directory) throw new Error('Data path is not set')
    return path.join(directory, STORE_NAMES.PLAY_TIME)
  }
  const init = () =>
    (loading ??= readFile(file(), 'utf8')
      .then((data) => {
        const value = parseInt(data)
        time = Number.isNaN(value) ? 0 : value
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          loading = undefined
          throw error
        }
      }))
  return {
    async getPlayTime() {
      await init()
      return time
    },
    async savePlayTime(value: number) {
      await init()
      time = value
      // Serialize writes so an older progress update cannot overwrite a newer one.
      const next = writing.catch(() => {}).then(() => writeFile(file(), String(value), 'utf8'))
      writing = next
      return next
    },
  }
}

let dataPath = ''
export const initPlayTimeStore = (directory: string) => {
  dataPath = directory
}
export const { getPlayTime, savePlayTime } = createPlayTimeStore(() => dataPath)
