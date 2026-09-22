export const LOCAL_STORE_KEYS = {
  mediaDeviceId: 'media_device_id',
  windowInfo: 'window_info',
  updateDownloadFailedTip: 'update__download_failed_tip',
  updateCheckFailedTip: 'update__check_failed_tip',
  lastUsedCommands: 'last_used_commands',
} as const

type LocalStoreKey = (typeof LOCAL_STORE_KEYS)[keyof typeof LOCAL_STORE_KEYS]
const scopedKey = (key: LocalStoreKey) =>
  import.meta.env.VITE_IS_WEB && location.pathname.startsWith('/u/') ? `${location.pathname.split('/')[2]}:${key}` : key
export const getItem = (key: LocalStoreKey) => {
  return localStorage.getItem(scopedKey(key))
}

export const setItem = (key: LocalStoreKey, value: string) => {
  localStorage.setItem(scopedKey(key), value)
}
