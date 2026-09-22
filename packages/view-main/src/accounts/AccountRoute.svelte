<script lang="ts">
  import Library from '@/views/Library/index.svelte'
  import AccountPage from './AccountPage.svelte'
  import { account } from './state.svelte'
</script>

{#if import.meta.env.VITE_IS_WEB && account.enabled && account.user}
  <AccountPage />
{:else}
  <Library />
{/if}
