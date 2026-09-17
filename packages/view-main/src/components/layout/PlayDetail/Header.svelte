<script lang="ts">
  import { windowDarg } from '@/shared/browser/widnow.svelte'
  import { t } from '@/plugins/i18n'
  import { setShowPlayDetail } from '@/modules/playDetail/store/action'
  import { onMount, type ComponentExports } from 'svelte'
  import LyricMenu from './RightLyric/LyricMenu.svelte'
  import { useSettingValue } from '@/modules/setting/reactive.svelte'
  import { appEvent } from '@/modules/app/store/event'
  import { useIsFullscreen } from '@/modules/app/reactive.svelte'
  import { setFullScreen } from '@/modules/app/store/action'

  const fullscreenState = useIsFullscreen()
  const lyricFontSize = useSettingValue('playDetail.style.fontSize')

  let domBtns = $state<HTMLDivElement>()
  let lyricMenu = $state<ComponentExports<typeof LyricMenu>>()

  onMount(() => {
    const getBtnEl = (el: HTMLElement | null): HTMLButtonElement | null => {
      return el ? (el.tagName == 'BUTTON' ? (el as HTMLButtonElement) : getBtnEl(el.parentNode as HTMLElement | null)) : null
    }
    const handleMouseover = (event: MouseEvent) => {
      const btn = getBtnEl(event.target as HTMLElement)
      if (!btn) return
      btn.classList.add('hover')
    }
    const handleMouseout = (event: MouseEvent) => {
      const btn = getBtnEl(event.target as HTMLElement)
      if (!btn) return
      btn.classList.remove('hover')
    }

    const unsub = appEvent.on('focus', () => {
      if (!domBtns) return
      for (const node of domBtns.childNodes) {
        if ((node as HTMLElement).tagName != 'BUTTON') continue
        ;(node as HTMLElement).classList.remove('hover')
      }
    })
    domBtns!.addEventListener('mouseover', handleMouseover)
    domBtns!.addEventListener('mouseout', handleMouseout)
    return () => {
      unsub()
      domBtns!.removeEventListener('mouseover', handleMouseover)
      domBtns!.removeEventListener('mouseout', handleMouseout)
    }
  })
</script>

{#snippet content()}
  <div bind:this={domBtns} class="control-btn no-drag">
    <button
      type="button"
      aria-label={$t('lyric_menu.lrc_size', { size: lyricFontSize.val })}
      onclick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        lyricMenu?.show(rect.left, rect.bottom)
      }}
    >
      <svg height="60%" viewBox="0 0 24 24"><use href="#icon-font-increase" /></svg>
    </button>
    {#if import.meta.env.VITE_IS_DESKTOP}
      {#if fullscreenState.isFullscreen}
        <button
          type="button"
          class="fullscreen"
          data-click-hide
          aria-label={$t('fullscreen_exit')}
          onclick={() => {
            setFullScreen(false)
          }}
        >
          <svg version="1.1" height="60%" viewBox="0 0 24 24">
            <use xlink:href="#icon-window-fullscreen-exit" />
          </svg>
        </button>
      {/if}
    {/if}
    <button
      type="button"
      class="hide"
      data-click-hide
      aria-label={$t('play_detail.hide_tip')}
      onclick={() => {
        setShowPlayDetail(false)
      }}
    >
      <svg version="1.1" height="35%" viewBox="0 0 30.727 30.727">
        <use xlink:href="#icon-window-hide" />
      </svg>
    </button>
  </div>
{/snippet}

{#if import.meta.env.VITE_IS_DESKTOP}
  <div class="header drag-no-modal">
    {@render content()}
  </div>
{/if}
{#if import.meta.env.VITE_IS_WEB}
  <div class="header" {@attach windowDarg}>
    {@render content()}
  </div>
{/if}

<LyricMenu bind:this={lyricMenu} />

<style lang="less">
  :global(.fullscreen) {
    .header {
      align-self: flex-start;
      // .control-btn {
      //   .close,
      //   .min {
      //     display: none;
      //   }
      //   .fullscreenExit {
      //     display: flex;
      //   }
      // }
    }
  }
  .header {
    position: relative;
    flex: none;
    flex: 0 0 @height-toolbar;
    align-self: flex-start;
    width: 100%;

    .control-btn {
      position: absolute;
      top: 0;
      right: 0;
      display: flex;

      button {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 46px;
        height: 30px;
        padding: 1px;
        color: var(--color-font-label);
        cursor: pointer;
        outline: none;
        background: none;
        border: none;
        transition: background-color 0.2s ease-in-out;

        &:global(.hover) {
          background-color: var(--color-button-background-hover);

          &.close {
            background-color: var(--color-btn-close);
          }
        }
      }

      // .fullscreenExit {
      //   display: none;
      // }
    }
  }
  @media (max-width: 600px), (pointer: coarse) {
    .header .control-btn button { height: 44px; }
  }
</style>
