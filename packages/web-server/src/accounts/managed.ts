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
export const protectRpc = <T extends object>(rpc: T, context: { role: 'admin' | 'user'; run: (action: () => Promise<unknown>) => Promise<unknown>; onError?: (name: string, error: unknown) => void }): T => {
  const actions: Record<string, (...args: any[]) => any> = { ...Object.fromEntries([...alwaysDenied, ...adminOnly].map(name => [name, async () => { throw new Error('Forbidden') }])), ...rpc }
  return Object.fromEntries(
    Object.entries(actions).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        try {
          if (alwaysDenied.has(name) || (context.role !== 'admin' && !userAllowed.has(name)))
            throw new Error('Forbidden')
          return await context.run(async () => {
            if (name === 'getExtensionErrorMessage' && context.role !== 'admin') return null
            if (name === 'getNewVersionInfo' && context.role !== 'admin') return {}
            if (name === 'getResourceList' && context.role !== 'admin') {
              const resources = await fn(...args)
              return { ...resources, commands: [], listProvider: [] }
            }
            if (name === 'getExtensionList' && context.role !== 'admin') {
              const list = (await fn(...args)) as Array<Record<string, unknown>>
              return list.map(sanitizeExtension)
            }
            return await fn(...args)
          })
        } catch (error) {
          context.onError?.(name, error)
          throw error
        }
      },
    ])
  ) as T
}
