import { setSetting } from '@/modules/app/store/action'
import { settingChangedEvent } from '@/shared/ipc/app/event'
import { getSetting as getRemoteSetting } from '@/shared/ipc/app'
import { getItem, LOCAL_STORE_KEYS, setItem } from '@/shared/localStore'

import * as commit from './commit'

export const updateSetting = async (setting: Partial<AnyListen.AppSetting>) => {
  if (import.meta.env.VITE_IS_WEB && 'playDetail.style.fontSize' in setting) {
    const { 'playDetail.style.fontSize': fontSize, ...remoteSetting } = setting
    setItem(LOCAL_STORE_KEYS.lyricFontSize, String(fontSize))
    commit.updateSetting(['playDetail.style.fontSize'], { 'playDetail.style.fontSize': fontSize })
    if (Object.keys(remoteSetting).length) await setSetting(remoteSetting)
    return
  }
  await setSetting(setting)
}

export const registerRemoteSettingAction = () => {
  return settingChangedEvent.on((keys, setting) => {
    if (import.meta.env.VITE_IS_WEB) {
      const { 'playDetail.style.fontSize': _fontSize, ...remoteSetting } = setting
      const remoteKeys = keys.filter((key) => key !== 'playDetail.style.fontSize')
      if (remoteKeys.length) commit.updateSetting(remoteKeys, remoteSetting)
      return
    }
    commit.updateSetting(keys, setting)
  })
}

export const getSetting = async () => {
  const setting = await getRemoteSetting()
  if (import.meta.env.VITE_IS_WEB) {
    const stored = getItem(LOCAL_STORE_KEYS.lyricFontSize)
    const fontSize = stored === null ? setting['playDetail.style.fontSize'] : Number(stored)
    if (Number.isFinite(fontSize) && fontSize >= 30 && fontSize <= 200) {
      setting['playDetail.style.fontSize'] = fontSize
    }
    setItem(LOCAL_STORE_KEYS.lyricFontSize, String(setting['playDetail.style.fontSize']))
  }
  return setting
}
