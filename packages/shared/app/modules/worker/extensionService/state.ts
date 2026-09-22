import { DEFAULT_LANG, EXTENSION_ENGINE } from '@any-listen/common/constants'
import { joinPath } from '@any-listen/nodejs'

const empty = {}
export const getExtensionLogDirectory = (extension: AnyListen.Extension.Extension) =>
  extensionState.logDir ? joinPath(extensionState.logDir, extension.id) : extension.dataDirectory
export const extensionState = {
  onlineOnly: false,
  draftOnly: false,
  version: EXTENSION_ENGINE,
  clientType: '' as AnyListen.ClientType,
  locale: DEFAULT_LANG as AnyListen.Locale,
  onlineExtensionHost: '',
  extensionI18nMessage: empty as Record<string, string>,
  proxy: {
    host: '',
    port: '',
  },
  enableDebug: false,
  configFilePath: '',
  extensionDir: '',
  dataDir: '',
  logDir: '',
  tempDir: '',
  extensions: [] as AnyListen.Extension.Extension[],
  // prettier-ignore
  // vmContexts: new Map<string, {
  //   extension: AnyListen.Extension.Extension
  //   key: string
  //   vmContext: AnyListen.ExtensionVM.VMContext
  // }>(),
  preloadScript: '',
  resourceList: {
    commands: [],
    resources: {},
    listProvider: [],
  } as AnyListen.Extension.ResourceList,
  extensionSettings: null as AnyListen.Extension.ExtensionSetting[] | null,
  remoteFuncs: empty as AnyListen.IPCExtension.MainIPCActions & {
    inited: () => void
  },
  newExtensionVersions: empty as Record<string, string>,
}
