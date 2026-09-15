<script lang="ts">
  import { verticalScrollbar } from '@/shared/compositions/verticalScrollbar.svelte'
  import SettingItem from './SettingItem.svelte'
  import Btn from '@/components/base/Btn.svelte'
  import { account } from '@/accounts/state.svelte'
  import { uploadSource } from '@/accounts/sources'
  import { showNotify } from '@/components/apis/notify'

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
  const handleImport = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    if (!file) return
    uploading = true
    try {
      const result = await uploadSource('script', file)
      await onimport?.()
      showNotify(`已导入：${result.name}`)
    } catch (error) {
      showNotify((error as Error).message)
    } finally {
      uploading = false
      input.value = ''
    }
  }
</script>

<div class="settings-list-container">
  <div class="settings-list" {@attach verticalScrollbar()}>
    <h3 class="settings-title">{name}</h3>
    {#if account.enabled && account.user?.role === 'admin' && id === 'lx-api-source-loader'}
      <div class="source-actions">
        <input bind:this={scriptInput} type="file" accept=".js" aria-label="LX 音源脚本" hidden disabled={uploading} onchange={(e) => handleImport(e.currentTarget)} />
        <Btn onclick={() => scriptInput?.click()} loading={uploading} min>导入脚本</Btn>
      </div>
    {/if}
    {#each list as item (item.field)}
      <SettingItem {id} {item} />
    {/each}
  </div>
</div>

<style lang="less">
  .source-actions {
    margin-bottom: 12px;
  }
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
