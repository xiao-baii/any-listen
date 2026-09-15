<script lang="ts">
  import { verticalScrollbar } from '@/shared/compositions/verticalScrollbar.svelte'
  import SettingItem from './SettingItem.svelte'
  import { account, accountRequest } from '@/accounts/state.svelte'
  import { exportSources, uploadSource } from '@/accounts/sources'
  import { showNotify } from '@/components/apis/notify'
  import { showInputBox } from '@/components/apis/inputModal/inputBox'
  import { extI18n } from '@/modules/extension/i18n'
  import { CANCELED_ERROR_MSG } from '@any-listen/common/constants'

  let {
    id,
    name,
    list,
    onimport,
  }: {
    id: string
    name: string
    list: AnyListen.Extension.FormValueItem[]
    onimport?: () => Promise<void>
  } = $props()

  let scriptInput = $state<HTMLInputElement>()
  let uploading = $state(false)
  const handleCommand = async (command: string) => {
    if (uploading || account.user?.role !== 'admin') return
    if (command === 'lx-api-source-loader.addLocalSource') { scriptInput?.click(); return }
    uploading = true
    try {
      switch (command) {
        case 'lx-api-source-loader.addRemoteSource': await handleRemoteImport(); break
        case 'lx-api-source-loader.exportSources': await exportSources(); break
        default: showNotify('此命令尚未适配多账号模式')
      }
    } catch (error) {
      if ((error as Error).message !== CANCELED_ERROR_MSG) showNotify((error as Error).message)
    } finally {
      uploading = false
    }
  }
  const handleImport = async (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? [])
    if (!files.length) return
    uploading = true
    try {
      for (const file of files) {
        try {
          const result = await uploadSource('script', file)
          showNotify(`已导入：${result.name}`)
        } catch (error) { showNotify(`${file.name}: ${(error as Error).message}`) }
      }
      await onimport?.()
    } catch (error) {
      showNotify((error as Error).message)
    } finally {
      uploading = false
      input.value = ''
    }
  }
  const handleRemoteImport = async () => {
    const url = await showInputBox({
      title: extI18n.t(id, '{command.addRemoteSourceDialogTitle}'),
      placeholder: extI18n.t(id, '{command.addRemoteSourceDialogPlaceholder}'),
      validateInput: async value => {
        try {
          const url = new URL(value.trim())
          if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return
        } catch {}
        return '请输入有效的 HTTP(S) 音源脚本地址'
      },
    })
    const result = await accountRequest('/source-remote', 'POST', { url: url.trim() })
    await onimport?.()
    showNotify(`已导入：${result.name}`)
  }
</script>

<div class="settings-list-container">
  <div class="settings-list" {@attach verticalScrollbar()}>
    <h3 class="settings-title">{name}</h3>
    {#if account.enabled && account.user?.role === 'admin' && id === 'lx-api-source-loader'}
      <input bind:this={scriptInput} type="file" accept=".js" multiple aria-label="LX 音源脚本" hidden disabled={uploading} onchange={(e) => handleImport(e.currentTarget)} />
    {/if}
    {#each list as item (item.field)}
      <SettingItem {id} {item} oncommand={account.enabled ? handleCommand : undefined} commandsDisabled={uploading} />
    {/each}
  </div>
</div>

<style lang="less">
  .settings-list-container {
    display: flex;
    flex: auto;
    flex-flow: column nowrap;
    min-width: 0;
    overflow: hidden;
  }
  .settings-list {
    position: relative;
    display: flex;
    flex: auto;
    flex-flow: column nowrap;
    min-height: 0;
    margin: 0 10px;
    // gap: 8px;
  }
</style>
