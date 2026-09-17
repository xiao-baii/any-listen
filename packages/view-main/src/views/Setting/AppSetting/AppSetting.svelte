<script lang="ts">
  import { query, replace } from '@/plugins/routes'
  import SettingList from './SettingList.svelte'
  import SettingView from './SettingView.svelte'
  import { settings } from './settings'
  import { account } from '@/accounts/state.svelte'

  const visibleSettings = $derived(account.enabled ? settings.filter((s) => !['security', 'update', 'backup', 'extension', 'network', 'onlineResource', 'dataSync'].includes(s.id)) : settings)
  const activeSetting = $derived(visibleSettings.find((e) => e.id == $query.id) ?? visibleSettings[0])
</script>

<div class="settings-app-container">
  {#if visibleSettings.length}
    <SettingList
      settings={visibleSettings}
      active={activeSetting.id}
      onchange={(id: string) => {
        void replace('/settings', { type: 'app', id })
      }}
    />
  {/if}
  {#if activeSetting}
    <SettingView settings={activeSetting} />
  {/if}
</div>

<style lang="less">
  .settings-app-container {
    display: flex;
    flex-flow: row nowrap;
    height: 100%;
    min-height: 0;
    padding-top: 10px;
  }
  @media (max-width: 600px) {
    .settings-app-container { flex-direction: column; }
  }
</style>
