import { hotKeyState as defaultHotKeyState } from '@any-listen/app/modules/hotkey'
import { Event } from '@any-listen/app/modules/hotkey/event'
import type { HOTKEY_Type } from '@any-listen/common/hotKey'
import type { EventType } from '@any-listen/nodejs/Event'

import defaultGetStore from '@/app/shared/store'

import { getHotKeyConfig as loadHotKeyConfig, saveHotKeyConfig } from './data'

export const createHotKeyModule = (getStore: typeof defaultGetStore) => {
  const event = new Event()
  const hotKeyEvent = event as EventType<Event>
  const hotKeyState: typeof defaultHotKeyState = {
    tempDisable: false,
    config: { local: { enable: false, keys: {} }, global: { enable: false, keys: {} } },
    state: new Map(),
  }

  const initHotKeyState = async () => {
    const config = await loadHotKeyConfig(getStore)
    hotKeyState.config.local = config.local
    hotKeyState.config.global = config.global
  }

  const initHotKey = async () => {
    await initHotKeyState()
  }

  const handleHotkeyConfigAction = async (action: AnyListen.HotKey.HotKeyActions<HOTKEY_Type>): Promise<boolean> => {
    switch (action.action) {
      case 'config':
        // global.anylisten.event_app.saveConfig(data, source)
        saveHotKeyConfig(action.data, getStore)
        hotKeyState.config = action.data
        hotKeyEvent.hot_key_config_update(action.data)
        return true
      case 'enable':
        hotKeyState.tempDisable = false
        return true
      case 'tempDisable':
        hotKeyState.tempDisable = action.data
        return true
      case 'register':
      case 'unregister':
        return true
      default:
        console.warn('unknown action:', action)
        // eslint-disable-next-line no-case-declarations, @typescript-eslint/no-unused-vars
        let unknownAction: never = action
        return false
    }
  }

  return {
    initHotKey,
    handleHotkeyConfigAction,
    hotKeyState,
    hotKeyEvent,
    getHotKeyConfig: () => hotKeyState.config,
    getHotkeyStatus: () => hotKeyState.state,
    closeHotKey: () => {
      event.listeners.clear()
      hotKeyState.state.clear()
    },
  }
}
const defaults = createHotKeyModule(defaultGetStore)
export const { initHotKey, handleHotkeyConfigAction, hotKeyState, hotKeyEvent, getHotKeyConfig, getHotkeyStatus, closeHotKey } =
  defaults
