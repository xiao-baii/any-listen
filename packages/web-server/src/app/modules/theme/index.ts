import { Event } from '@any-listen/app/modules/theme/event'
import type { EventType } from '@any-listen/nodejs/Event'

import { appEvent as defaultAppEvent } from '@/app/app/event'
import { appState as defaultAppState } from '@/app/app/state'
import defaultGetStore from '@/app/shared/store'

import { createThemeData } from './data'

export const createThemeModule = (
  appState: typeof defaultAppState,
  appEvent: typeof defaultAppEvent,
  getStore: typeof defaultGetStore
) => {
  const data = createThemeData(appState, getStore)
  const { getAllThemes, getTheme, removeTheme: removeThemeData, saveTheme: saveThemeData } = data
  const event = new Event()
  const themeEvent = event as EventType<Event>
  const themeState: AnyListen.ThemeSetting = { id: '', name: '', isDark: false, colors: {} }
  const subscriptions: Array<() => void> = []

  const initTheme = async () => {
    if (subscriptions.length) return
    Object.assign(themeState, getTheme())
    const watchConfigKeys: Array<keyof AnyListen.AppSetting> = ['theme.id', 'theme.lightId', 'theme.darkId']
    subscriptions.push(
      appEvent.on('updated_config', (keys) => {
        let requireUpdate = false
        for (const key of keys) {
          if (watchConfigKeys.includes(key)) {
            requireUpdate = true
            break
          }
        }
        if (requireUpdate) {
          const theme = getTheme()
          if (theme.id == themeState.id) return
          Object.assign(themeState, theme)
          themeEvent.theme_change(themeState)
        }
      })
    )
    subscriptions.push(
      appEvent.on('system_theme_change', () => {
        if (appState.appSetting['theme.id'] == 'auto') {
          const theme = getTheme()
          if (theme.id == themeState.id) return
          Object.assign(themeState, theme)
          themeEvent.theme_change(themeState)
        }
      })
    )
  }

  const getThemeSetting = () => {
    return themeState
  }

  const getThemeList = () => {
    return getAllThemes()
  }

  const saveTheme = (theme: AnyListen.Theme) => {
    saveThemeData(theme)
    themeEvent.theme_list_change(getAllThemes())
  }

  const removeTheme = (id: string) => {
    removeThemeData(id)
    themeEvent.theme_list_change(getAllThemes())
  }

  return {
    initTheme,
    getThemeSetting,
    getThemeList,
    saveTheme,
    removeTheme,
    themeEvent,
    themeState,
    closeTheme() {
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
      event.listeners.clear()
      data.close()
    },
  }
}
const defaults = createThemeModule(defaultAppState, defaultAppEvent, defaultGetStore)
export const { initTheme, getThemeSetting, getThemeList, saveTheme, removeTheme, themeEvent, themeState, closeTheme } = defaults
