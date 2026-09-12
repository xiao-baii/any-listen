<script>
  import Pic from './components/Pic.svelte'
  import PlayInfo from './components/PlayInfo.svelte'
  import PlayBtns from './components/PlayBtns.svelte'
  import ControlBtns from './components/ControlBtns.svelte'
  import MiniPlayProgress from './components/MiniPlayProgress.svelte'
</script>

<div class="mobile-player">
  <div class="track"><Pic /><PlayInfo /></div>
  <div class="play"><PlayBtns /><MiniPlayProgress /></div>
  <div class="tools"><ControlBtns /></div>
</div>

<style>
  .mobile-player { flex: none; position: relative; z-index: 2; border-top: 1px solid var(--color-border); background: var(--color-app-background); padding: 0 10px 8px; }
  .track { display: flex; height: 48px; align-items: center; min-width: 0; }
  .play { display: flex; height: 42px; justify-content: space-between; align-items: center; gap: 8px; }
  .tools { display: flex; justify-content: center; height: 32px; align-items: center; }
</style>
