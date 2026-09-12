<script lang="ts">
  import Btn from '@/components/base/Btn.svelte'
  import SvgIcon from '@/components/base/SvgIcon.svelte'
  import { t } from '@/plugins/i18n'
  import type { ListInfo } from './type'
  import Image from '@/components/base/Image.svelte'
  let {
    source,
    disabled,
    listinfo,
    musiccount,
    multimode,
    finding,
    saveable,
    onplay,
    onplayrandom,
    onsave,
    onmulti,
    onfind,
    onduplicate,
    onsort,
  }: {
    source: AnyListen.Player.SourceType
    disabled: boolean
    listinfo: ListInfo
    musiccount: number
    multimode: boolean
    finding: boolean
    saveable?: boolean
    onplay: () => void
    onplayrandom: () => void
    onsave: () => void
    onmulti: () => void
    onfind: () => void
    onduplicate: () => void
    onsort: () => void
  } = $props()
</script>

<div class="header">
  <div class="left">
    <Image src={listinfo.pic} icon={listinfo.picIcon} />
  </div>
  <div class="right">
    <div class="info">
      <h3 class="title">{listinfo.name}</h3>
      <div class="info-item">
        <span><SvgIcon name="music" />{musiccount}</span>
        {#if listinfo.playCount}
          <span><SvgIcon name="headphones" />{listinfo.playCount}</span>
        {/if}
      </div>
      {#if listinfo.createTime}
        <div class="info-item">
          <span><SvgIcon name="clock" />{listinfo.createTime}</span>
        </div>
      {/if}
    </div>
    <div class="control-btns">
      <div class="btns">
        <Btn disabled={!musiccount || disabled} icontext onclick={onplay}>
          <SvgIcon name="play" />
          {$t('play_all')}
        </Btn>
        <Btn disabled={!musiccount || disabled} icontext onclick={onplayrandom}>
          <SvgIcon name="list-random" />
          {$t('play_random')}
        </Btn>
        {#if source !== 'local' && saveable}
          <Btn {disabled} icontext onclick={onsave}>
            <SvgIcon name="favorite_folder" />
            {$t('save_list')}
          </Btn>
        {/if}
      </div>
      <div class="btns">
        <Btn outline={!multimode} icon onclick={onmulti} aria-label={multimode ? $t('batch_select_exit') : $t('batch_select')}>
          <SvgIcon name="multiple" />
        </Btn>
        <Btn outline={!finding} icon onclick={onfind} aria-label={finding ? $t('find_music_exit') : $t('find_music')}>
          <SvgIcon name="search" />
        </Btn>
        {#if source === 'local'}
          <Btn disabled={!musiccount} outline icon onclick={onduplicate} aria-label={$t('duplicate_music')}>
            <SvgIcon name="duplicate" />
          </Btn>
          <Btn disabled={!musiccount} outline icon onclick={onsort} aria-label={$t('sort_music')}>
            <SvgIcon name="sort" />
          </Btn>
        {/if}
      </div>
    </div>
  </div>
</div>

<style lang="less">
  @media (max-width: 600px) {
    :global(html.multi-user) .header { flex-wrap: wrap; gap: 10px; }
    :global(html.multi-user) .left { width: 64px; height: 64px; flex: none; }
    :global(html.multi-user) .right { min-width: 0; width: calc(100% - 74px); padding-left: 0; }
    :global(html.multi-user) .title { font-size: 18px; overflow-wrap: anywhere; }
    :global(html.multi-user) .control-btns { gap: 8px; }
    :global(html.multi-user) .control-btns .btns { flex-wrap: wrap; flex-shrink: 1; }
  }
  .header {
    // height: 46px;
    display: flex;
    flex: none;
    flex-flow: row nowrap;
    // align-items: center;
    padding: 10px 15px 10px 12px;
  }

  .left {
    width: 140px;
    height: 140px;
  }

  .right {
    display: flex;
    flex: auto;
    flex-flow: column nowrap;
    justify-content: space-between;
    padding-top: 2px;
    padding-bottom: 5px;
    padding-left: 15px;
  }

  .title {
    font-size: 24px;
  }

  // .info {
  // }

  .info-item {
    display: flex;
    flex-flow: row wrap;
    gap: 10px;
    padding-top: 5px;
    font-size: 13px;
    color: var(--color-font-label);

    + .info-item {
      padding-top: 0;
    }

    :global(svg) {
      margin-right: 5px;
    }
  }

  .control-btns {
    display: flex;
    // gap: 10px;
    flex-flow: row wrap;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    margin-top: 15px;

    .btns {
      display: flex;
      flex: none;
      flex-flow: row nowrap;
      gap: 10px;
    }
    // :global(.btn) {
    //   margin-right: 10px;
    // }
  }
</style>
