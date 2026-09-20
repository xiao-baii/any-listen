<script lang="ts">
  import Header from './Header.svelte'
  import { query, replace } from '@/plugins/routes'
  import { account } from '@/accounts/state.svelte'
  import { viewTypes } from './shared'
  import InstalledList from './InstalledList.svelte'
  import OnlineList from './OnlineList.svelte'

  let activeView = $derived<(typeof viewTypes)[number]>(viewTypes.find((t) => t == $query.type) ?? 'installed')
  const allowed = $derived(!account.enabled || account.user?.role === 'admin')
  $effect(() => {
    if (!allowed) void replace('/library')
  })
</script>

<div class="view-container container">
  {#if allowed}
    <Header activeview={activeView} />
    {#if activeView == 'online'}
      <OnlineList />
    {:else}
      <InstalledList type={activeView} />
    {/if}
  {/if}
</div>

<style lang="less">
  .container {
    // padding: 10px 15px;
    display: flex;
    flex-flow: column nowrap;
  }
</style>
