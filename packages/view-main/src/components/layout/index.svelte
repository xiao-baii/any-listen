<script lang="ts">
  import Aside from '@/components/layout/Aside/index.svelte'
  import Header from '@/components/layout/Header/index.svelte'
  import Main from '@/components/layout/Main.svelte'
  import PlayBar from '@/components/layout/PlayBar/index.svelte'
  import PlayDetail from '@/components/layout/PlayDetail/index.svelte'
  import { account } from '@/accounts/state.svelte'
  import { location as routeLocation, query as routeQuery } from '@/plugins/routes'
  import { innerWidth } from 'svelte/reactivity/window'
  import MobileBar from './PlayBar/MobileBar.svelte'
  let showNavigation = $state(false)
  $effect(() => { $routeLocation; $routeQuery; showNavigation = false })
</script>

{#if account.enabled}<div class="mobile-navigation"><button aria-label="歌单导航" aria-expanded={showNavigation} onclick={() => { showNavigation = !showNavigation }}><svg viewBox="0 0 24 24"><use href="#icon-playlist" /></svg></button><span>Any Listen</span><a href="/">{account.user?.username}</a></div>{/if}
<div id="app-main" class:show-navigation={showNavigation}>
  <Aside />
  <div id="app-right">
    <Header />
    {#if account.enabled}<a class="account-link" href="/">{account.user?.username} · 账号管理</a>{/if}
    <Main />
  </div>
</div>
{#if account.enabled && (innerWidth.current ?? 1024) <= 600}<MobileBar />{:else}<PlayBar />{/if}
<PlayDetail />

<style lang="less">
  .account-link { padding: 5px 15px; color: var(--color-font); font-size: 12px; text-align: right; }
  .mobile-navigation { display: none; }
  @media (max-width: 600px) {
    .mobile-navigation { display: flex; align-items: center; flex: none; gap: 12px; height: 44px; padding: 0 12px; border-bottom: 1px solid var(--color-border); }
    .mobile-navigation button { width: 32px; height: 32px; padding: 4px; border: 0; background: transparent; color: var(--color-font); }
    .mobile-navigation svg { width: 24px; height: 24px; }
    .mobile-navigation a { margin-left: auto; max-width: 50%; overflow: hidden; text-overflow: ellipsis; color: var(--color-font); }
    :global(html.multi-user) #app-main > :global(.aside) { display: none; position: absolute; inset: 0 auto 0 0; z-index: 8; width: 260px; max-width: 85%; background: var(--color-content-background, white); box-shadow: 2px 0 6px #0003; }
    :global(html.multi-user) #app-main.show-navigation > :global(.aside) { display: flex; }
    :global(html.multi-user) .account-link { display: none; }
  }
  #app-main {
    position: relative;
    z-index: 1;
    display: flex;
    flex: auto;
    flex-flow: row nowrap;
  }
  #app-right {
    position: relative;
    display: flex;
    // border-left: 2px solid var(--color-border);

    flex: auto;
    flex-flow: column nowrap;

    // border-top-left-radius: @radius-border;
    // border-bottom-left-radius: @radius-border;
    overflow: hidden;
    // box-shadow: 0px 0px 4px rgba(0, 0, 0, 0.1);

    // &:before {
    //   .mixin-after();
    //   left: 0;
    //   top: 0;
    //   width: 100%;
    //   height: 100%;
    //   transition: background-color @transition-normal;
    //   background-color: var(--color-main-background);
    //   opacity: .9;
    //   // z-index: -1;
    // }
  }
</style>
