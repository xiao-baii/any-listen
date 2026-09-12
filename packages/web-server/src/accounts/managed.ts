import type { IncomingMessage } from 'node:http'

import { verifyIdentity } from './security'

export const managed = Boolean(process.env.ANYLISTEN_USER_ID)
export const identityFor = (req: IncomingMessage) =>
  verifyIdentity(
    req.headers['x-anylisten-identity'],
    process.env.ANYLISTEN_INTERNAL_SECRET ?? '',
    process.env.ANYLISTEN_USER_ID ?? ''
  )
export const managedRole = () => (process.env.ANYLISTEN_ROLE === 'admin' ? 'admin' : 'user')
export const sanitizeExtension = (extension: Record<string, unknown>) => ({
  id: extension.id,
  name: extension.name,
  version: extension.version,
  enabled: extension.enabled,
  loaded: extension.loaded,
  internal: extension.internal,
  icon: extension.icon,
  contributes: { resource: (extension.contributes as { resource?: unknown })?.resource },
})

const alwaysDenied = new Set([
  'downloadUpdate',
  'restartUpdate',
  'getLoginDevices',
  'removeLoginDevice',
  'exportData',
  'importData',
])
const adminOnly = new Set([
  'downloadAndParseExtension',
  'installExtension',
  'updateExtension',
  'startExtension',
  'enableExtension',
  'disableExtension',
  'restartExtension',
  'uninstallExtension',
  'restartExtensionHost',
  'getOnlineExtensionList',
  'getOnlineExtensionDetail',
  'getOnlineCategories',
  'getOnlineTags',
  'getExtensionLastLogs',
  'clearExtensionLogs',
  'getAllExtensionSettings',
  'getExtensionConfigValues',
  'updateExtensionSettings',
  'executeCommand',
  'fileSystemAction',
  'addFolderMusics',
  'createLocalMusicInfos',
  'parseMusicMetadata',
  'getAppLogs',
  'clearAppLog',
  'listProviderAction',
])
// Explicitly enumerate the ordinary-user surface so an upstream RPC addition fails closed.
const userAllowed = new Set([
  'inited',
  'setSystemThemeMode',
  'getAppInfo',
  'getSetting',
  'setSetting',
  'getCurrentVersionInfo',
  'checkUpdate',
  'getCacheSize',
  'clearCache',
  'getLastStartInfo',
  'saveLastStartInfo',
  'getListPrevSelectId',
  'saveListPrevSelectId',
  'getSearchHistoryList',
  'saveSearchHistoryList',
  'saveIgnoreVersion',
  'getHotKey',
  'hotkeyConfigAction',
  'getDislikeInfo',
  'dislikeAction',
  'getThemeSetting',
  'getThemeList',
  'saveTheme',
  'removeTheme',
  'getPlayInfo',
  'playerEvent',
  'playListAction',
  'playHistoryListAction',
  'getAllUserLists',
  'getListMusics',
  'getListCover',
  'getMusicExistListIds',
  'checkListExistMusic',
  'listAction',
  'getListScrollPosition',
  'saveListScrollPosition',
  'syncUserList',
  'sortListMusics',
  'getMusicUrl',
  'getMusicUrlCount',
  'clearMusicUrl',
  'getMusicPic',
  'getMusicLyric',
  'setMusicLyric',
  'removeMusicLyric',
  'getMusicLyricCount',
  'clearMusicLyric',
  'tipSearch',
  'hotSearch',
  'musicSearch',
  'musicPicSearch',
  'lyricSearch',
  'lyricDetail',
  'songlistSearch',
  'songlistSorts',
  'songlistTags',
  'songlist',
  'songlistDetail',
  'topSongs',
  'topSongsDate',
  'topSongsDetail',
  'findMusic',
  'musicComment',
  'getSyncState',
  'runSyncWebDAV',
  'getUserSoundEffectEQPresetList',
  'saveUserSoundEffectEQPresetList',
  'getUserSoundEffectConvolutionPresetList',
  'saveUserSoundEffectConvolutionPresetList',
  'getExtensionErrorMessage',
  'getNewVersionInfo',
  'getResourceList',
  'getExtensionList',
])
export let activeCalls = 0
export const protectRpc = <T extends object>(rpc: T): T => {
  if (!managed) return rpc
  return Object.fromEntries(
    Object.entries(rpc).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        if (alwaysDenied.has(name) || (managedRole() !== 'admin' && (adminOnly.has(name) || !userAllowed.has(name))))
          throw new Error('Forbidden')
        activeCalls++
        try {
          if (name === 'getExtensionErrorMessage' && managedRole() !== 'admin') return null
          if (name === 'getNewVersionInfo' && managedRole() !== 'admin') return {}
          if (name === 'getResourceList' && managedRole() !== 'admin') {
            const resources = await fn(...args)
            return { ...resources, commands: [], listProvider: [] }
          }
          if (name === 'getExtensionList' && managedRole() !== 'admin') {
            const list = (await fn(...args)) as Array<Record<string, unknown>>
            return list.map(sanitizeExtension)
          }
          return await fn(...args)
        } finally {
          activeCalls--
        }
      },
    ])
  ) as T
}
