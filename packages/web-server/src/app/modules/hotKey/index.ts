import { hotKeyState as defaultHotKeyState } from '@any-listen/app/modules/hotkey'
import { Event } from '@any-listen/app/modules/hotkey/event'
import type { EventType } from '@any-listen/nodejs/Event'

import { getStore as defaultGetStore } from '@/app/shared/store'

import { getHotKeyConfig as loadHotKeyConfig, saveHotKeyConfig } from './data'

export const createHotKeyModule = (getStore: typeof defaultGetStore) => {
  const event = new Event()
  const hotKeyEvent = event as EventType<Event>
  const hotKeyState: typeof defaultHotKeyState = {
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

  const handleHotkeyConfigAction = async (action: AnyListen.HotKey.HotKeyActions) => {
    switch (action.action) {
      case 'config':
        hotKeyState.config[action.data.type].keys = action.data.config
        saveHotKeyConfig(hotKeyState.config, getStore)
        hotKeyEvent.config_updated(action.data)
        break
      case 'enable':
        hotKeyState.config[action.data.type].enable = action.data.enable
        saveHotKeyConfig(hotKeyState.config, getStore)
        hotKeyEvent.enable_chenged(action.data)
        break
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
