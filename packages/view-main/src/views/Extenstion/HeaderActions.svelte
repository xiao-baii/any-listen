<script lang="ts">
  import Btn from '@/components/base/Btn.svelte'
  import { i18n, t } from '@/plugins/i18n'
  import { showOpenDialog } from '@/shared/ipc/app'
  import { downloadAndParseExtension, getExtensionList, installExtension, setList, updateExtension } from '@/modules/extension/store/actions'
  import { EXTENSION } from '@any-listen/common/constants'
  import { showNotify } from '@/components/apis/notify'
  import { extensionState } from '@/modules/extension/store/state'
  import { account } from '@/accounts/state.svelte'
  import { uploadSource } from '@/accounts/sources'

  let packageInput = $state<HTMLInputElement>()
  let uploading = $state(false)
  const handleUpload = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    if (!file) return
    uploading = true
    try {
      const result = await uploadSource('package', file)
      setList(await getExtensionList())
      showNotify(`已安装：${result.name}`)
    } catch (error) {
      showNotify((error as Error).message)
    } finally {
      uploading = false
      input.value = ''
    }
  }

  const handleInstallLocal = async () => {
    const { canceled, filePaths } = await showOpenDialog({
      title: i18n.t('extension.select_local_file'),
      properties: ['openFile'],
      filters: [
        // https://support.google.com/chromebook/answer/183093
        // 3gp, .avi, .mov, .m4v, .m4a, .mp3, .mkv, .ogm, .ogg, .oga, .webm, .wav
        { name: 'ALIX File', extensions: [EXTENSION.pkgExtName] },
      ],
    })
    if (canceled || !filePaths.length) return
    const path = filePaths[0]
    const info = await downloadAndParseExtension(path).catch((e: Error) => {
      console.error(e)
      showNotify(i18n.t('extension__install_local_failed', { msg: e.message }))
      throw e
    })
    const targetExt = extensionState.extensionList.find((ext) => ext.id === info.id)
    if (targetExt) {
      if (targetExt.publicKey != info.publicKey) {
        showNotify(i18n.t('extension.install_local_failed.public_key_not_match'))
        return
      }
      await updateExtension(info).catch((e: Error) => {
        console.error(e)
        showNotify(i18n.t('extension__install_local_failed', { msg: e.message }))
        throw e
      })
    } else {
      await installExtension(info).catch((e: Error) => {
        console.error(e)
        showNotify(i18n.t('extension__install_local_failed', { msg: e.message }))
        throw e
      })
    }
    showNotify(i18n.t('extension__install_local_success'))
  }
</script>

{#if !account.enabled || account.user?.role === 'admin'}
  <div class="header-actions">
    {#if account.enabled}
      <input bind:this={packageInput} type="file" accept=".alix" aria-label="音源扩展包" hidden disabled={uploading} onchange={(e) => handleUpload(e.currentTarget)} />
      <Btn onclick={() => packageInput?.click()} loading={uploading} min>{$t('extension.header.actions.install_local')}</Btn>
    {:else}
      <Btn onclick={handleInstallLocal} min>{$t('extension.header.actions.install_local')}</Btn>
    {/if}
  </div>
{/if}

<style lang="less">
  .header-actions {
    display: flex;
    flex: none;
    flex-flow: row nowrap;
    align-items: center;
  }
</style>
