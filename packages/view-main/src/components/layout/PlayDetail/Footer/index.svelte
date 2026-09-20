<script lang="ts">
  import RightControlBtns from './RightControlBtns.svelte'
  import LeftControlBtns from './LeftControlBtns.svelte'
  import MiddlePlayProgress from './MiddlePlayProgress.svelte'
  import PlayBtns from './PlayBtns.svelte'
  import PlayStatusText from './PlayStatusText.svelte'
  import { fade } from 'svelte/transition'

  let { introend }: { introend: boolean } = $props()
</script>

<div class="footer">
  {#if introend}
    <div in:fade={{ delay: 5 }} class="footer-content">
      <div class="control">
        <div class="side">
          <LeftControlBtns />
        </div>
        <PlayBtns />
        <div class="side right">
          <RightControlBtns />
        </div>
      </div>
      <MiddlePlayProgress />
      <PlayStatusText />
    </div>
  {/if}
</div>

<style lang="less">
  .footer {
    flex: none;
    height: 100px;
    contain: strict;
  }
  .footer-content {
    position: relative;
    display: flex;
    flex-flow: column nowrap;
    height: 100%;
    padding: 0 30px 16px;
    > :global(.middle-play-progress) {
      flex: none;
      width: 100%;
    }
  }
  .control {
    display: flex;
    flex: auto;
    flex-flow: row nowrap;
  }

  .side {
    position: relative;
    display: flex;
    flex: 1;
    flex-flow: row nowrap;
    align-items: center;
    height: 100%;
    padding-top: 15px;
  }

  .right {
    justify-content: flex-end;
    padding-left: 16px;
    margin-left: -10px;
  }
  @media (max-width: 600px) {
    .footer {
      height: calc(170px + env(safe-area-inset-bottom));
    }
    .footer-content {
      box-sizing: border-box;
      padding: 0 6px calc(8px + env(safe-area-inset-bottom));
    }
    .control {
      display: grid;
      grid-template-columns: 3fr 4fr;
      grid-template-rows: 58px 44px;
      align-items: center;
      > :global(.container) {
        grid-column: 1 / -1;
        grid-row: 1;
        justify-self: center;
      }
    }
    .side {
      grid-row: 2;
      padding: 0;
      margin: 0;
    }
  }
  @media (max-width: 600px), (pointer: coarse) {
    .side > :global(.container) {
      align-items: center;
      gap: 0;
    }
    .side :global(button),
    .side :global(button.btn) {
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 44px;
      padding: 10px;
    }
  }
</style>
