<script lang="ts">
  import Icons from '@/components/layout/Icons.svelte'
  import AppLayout from '@/components/layout/index.svelte'
  import Loading from '@/components/layout/Loading.svelte'
  import Login from '@/views/Login/index.svelte'
  import { useAppAeady, useShowLogin } from '@/modules/app/reactive.svelte'
  import { onMount } from 'svelte'
  import { account } from './accounts/state.svelte'
  import AccountPage from './accounts/AccountPage.svelte'

  const appReady = useAppAeady()
  const showLogin = useShowLogin()

  onMount(() => {
    document.getElementById('root')!.style.display = 'block'
  })
</script>

<div id="container" class="view-container">
  <Icons />
  {#if import.meta.env.VITE_IS_DESKTOP}
    {#if appReady.appAeady}
      <AppLayout />
    {/if}
  {/if}
  {#if import.meta.env.VITE_IS_WEB}
    {#if account.ready && account.enabled && (!account.user || account.user.mustChangePassword || !location.pathname.startsWith(`/u/${account.user.id}/`))}
      <AccountPage />
    {:else}
    {#if appReady.appAeady}
      <AppLayout />
    {:else}
      <Loading />
    {/if}
    {#if showLogin.showLogin}
      <Login />
    {/if}
    {/if}
  {/if}
  <!-- <layout-view id="view" />
  <layout-play-bar id="player" />
  <layout-icons />
  <layout-change-log-modal />
  <layout-update-modal />
  <layout-pact-modal />
  <layout-sync-mode-modal />
  <layout-sync-auth-code-modal />
  <layout-play-detail /> -->
</div>
