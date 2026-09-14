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
export const sanitizeExtension = (extension: { id?: unknown; name?: unknown; version?: unknown; enabled?: unknown; loaded?: unknown; internal?: unknown; icon?: unknown; i18nMessages?: unknown; contributes?: unknown }) => ({
  id: extension.id,
  name: extension.name,
  version: extension.version,
  enabled: extension.enabled,
  loaded: extension.loaded,
  internal: extension.internal,
  icon: extension.icon,
  i18nMessages: extension.i18nMessages ?? {},
  contributes: { resource: (extension.contributes as { resource?: unknown })?.resource },
})

const alwaysDenied = new Set([
  'downloadUpdate',
  'restartUpdate',
  'getLoginDevices',
  'removeLoginDevice',
  'exportData',
  'importData',
  'runSyncWebDAV',
  'fileSystemAction',
  'addFolderMusics',
  'createLocalMusicInfos',
  'parseMusicMetadata',
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
export const protectRpc = <T extends object>(rpc: T, context?: { role: 'admin' | 'user'; run: (action: () => Promise<unknown>) => Promise<unknown> }): T => {
  if (!managed && !context) return rpc
  const role = () => context?.role ?? managedRole()
  const actions: Record<string, (...args: any[]) => any> = { ...Object.fromEntries([...alwaysDenied, ...adminOnly].map(name => [name, async () => { throw new Error('Forbidden') }])), ...rpc }
  return Object.fromEntries(
    Object.entries(actions).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        if (alwaysDenied.has(name) || (role() !== 'admin' && (adminOnly.has(name) || !userAllowed.has(name))))
          throw new Error('Forbidden')
        const call = async () => {
        activeCalls++
        try {
          if (name === 'getExtensionErrorMessage' && role() !== 'admin') return null
          if (name === 'getNewVersionInfo' && role() !== 'admin') return {}
          if (name === 'getResourceList' && role() !== 'admin') {
            const resources = await fn(...args)
            return { ...resources, commands: [], listProvider: [] }
          }
          if (name === 'getExtensionList' && role() !== 'admin') {
            const list = (await fn(...args)) as Array<Record<string, unknown>>
            return list.map(sanitizeExtension)
          }
          return await fn(...args)
        } finally {
          activeCalls--
        }
        }
        return context ? context.run(call) : call()
      },
    ])
  ) as T
}
