// import '@common/utils/rendererError'
import { mount } from 'svelte'

import { account, initAccount } from './accounts/state.svelte'

import 'virtual:svg-icons-register'

import './app.less'
import App from './App.svelte'
import { initNotify } from './components/apis/notify'
import { initTooltips } from './components/apis/tooltips/global'
import { connectIPC, registerModules } from './modules'
import { initIpcDesktopLyric } from './shared/ipcLyric/init'
import { initWorkers } from './worker'

// import './components/base/VirtualizedList'
void initWorkers()

mount(App, {
  target: document.getElementById('root')!,
})
initNotify()

registerModules()
initIpcDesktopLyric()
void initAccount().then(() => {
  if (
    !account.enabled ||
    (account.user && !account.user.mustChangePassword && location.pathname.startsWith(`/u/${account.user.id}/`))
  )
    connectIPC()
})
initTooltips()
