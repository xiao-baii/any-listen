<script lang="ts">
  import Header from './Header.svelte'
  import Selection from '@/components/base/Selection.svelte'
  import { filterSinger, getSingerOptions } from '@any-listen/common/singers'
  import { playMusicCollection } from '@/modules/player/store/playerActions'
  import { t } from '@/plugins/i18n'
  import { playMusic } from './List/action'
  import List from './List/index.svelte'
  import type { ListInfo } from './type'
  import { updateSetting } from '@/modules/setting/store/action'
  import { getRandom } from '@/shared'
  import { untrack, type ComponentExports } from 'svelte'
  import MiniHeader from './MiniHeader.svelte'
  import Loading from '@/components/base/Loading.svelte'
  import { getListMetaInfo } from './shared'
  let {
    loading = false,
    error = false,
    source = 'local',
    showheader = true,
    miniheader = false,
    list,
    listinfo,
    onscroll,
    onsave,
    onreload,
    onplaymusic,
  }: {
    loading?: boolean
    error?: boolean
    source?: AnyListen.Player.SourceType
    showheader?: boolean
    miniheader?: boolean
    list: AnyListen.Music.MusicInfo[]
    listinfo: ListInfo
    onscroll?: (pos: number) => void
    onsave?: () => Promise<void>
    onreload?: () => void
    onplaymusic?: (music: AnyListen.Music.MusicInfo, random?: boolean) => void
  } = $props()
  let selectedSinger = $state('')
  let singerListId = $state('')
  $effect(() => {
    const id = listinfo.id
    untrack(() => { selectedSinger = ''; singerListId = id })
  })
  const singer = $derived(singerListId === listinfo.id && source === 'local' ? selectedSinger : '')
  const visibleList = $derived(filterSinger(list, singer))
  const singerOptions = $derived([
    { name: '', label: $t('singer_all') },
    ...getSingerOptions(list).map(({ name, count }) => ({ name, label: name + ' · ' + count })),
  ])
  const handlePlay = async (music: AnyListen.Music.MusicInfo, random = false, fromHeader = false) => {
    if (!music || loading || error) return
    if (onplaymusic) { onplaymusic(music, fromHeader ? random : undefined); return }
    if (singer) {
      if (fromHeader) await updateSetting({ 'player.togglePlayMethod': random ? 'random' : 'listLoop' })
      await playMusicCollection(listinfo.id, visibleList, visibleList.findIndex((m) => m.id === music.id), source)
    } else {
      if (random) await updateSetting({ 'player.togglePlayMethod': 'random' })
      await playMusic(listinfo.id, list, music, source, getListMetaInfo(listinfo), fromHeader)
    }
  }
  let multimode = $state(false)
  let finding = $state(false)
  let duplicate = $state(false)
  let listsort = $state(false)
  let musicList = $state<ComponentExports<typeof List> | null>(null)

  export const setScrollPosition = (number: number, animate?: boolean) => {
    musicList?.setScrollPosition(number, animate)
  }
  export const setScrollIndex = (number: number, animate?: boolean) => {
    musicList?.setScrollIndex(number, animate)
  }
  export const getScrollPosition = () => {
    return musicList?.getScrollPosition() ?? 0
  }
</script>

<div class="view-container container" class:loading>
  {#if showheader}
    {#if miniheader}
      <MiniHeader
        disabled={loading || error}
        musiccount={visibleList.length}
        loop={!!singer || !!onplaymusic}
        {source}
        saveable={listinfo.saveable}
        {multimode}
        {finding}
        onfind={() => {
          finding = !finding
        }}
        onduplicate={() => {
          duplicate = true
        }}
        onmulti={() => {
          multimode = !multimode
        }}
        onplay={() => {
          void handlePlay(visibleList[0], false, true)
        }}
        onplayrandom={() => { void handlePlay(visibleList[getRandom(0, visibleList.length)], true, true) }}
        onsort={() => {
          listsort = true
        }}
        onsave={async () => {
          await onsave?.()
        }}
      />
    {:else}
      <Header
        disabled={loading || error}
        {listinfo}
        musiccount={visibleList.length}
        loop={!!singer || !!onplaymusic}
        {source}
        saveable={listinfo.saveable}
        {multimode}
        {finding}
        onfind={() => {
          finding = !finding
        }}
        onduplicate={() => {
          duplicate = true
        }}
        onmulti={() => {
          multimode = !multimode
        }}
        onplay={() => {
          void handlePlay(visibleList[0], false, true)
        }}
        onplayrandom={() => { void handlePlay(visibleList[getRandom(0, visibleList.length)], true, true) }}
        onsort={() => {
          listsort = true
        }}
        onsave={async () => {
          await onsave?.()
        }}
      />
    {/if}
  {/if}
  {#if source === 'local'}
    <div class="singer-filter">
      <span>{$t('singer_label')}</span>
      <Selection arialabel={$t('singer_label')} value={singer} list={singerOptions} itemkey="name" itemname="label" onchange={(value) => {
        selectedSinger = value
        singerListId = listinfo.id
      }} />
    </div>
  {/if}
  <List
    bind:this={musicList}
    {listinfo}
    list={visibleList}
    onplay={(music) => { void handlePlay(music) }}
    {source}
    {onscroll}
    bind:finding
    bind:multimode
    bind:duplicate
    bind:listsort
    loaded={!loading && !error}
  />
  <Loading {loading} {error} {onreload} />
</div>

<style lang="less">
  .singer-filter {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    min-width: 0;
    --selection-width: min(300px, calc(100vw - 110px));
    :global(.button), :global(.list-item) { min-height: 44px; }
    :global(.label) { min-width: 0; }
  }
  .container {
    position: relative;
    display: flex;
    flex: auto;
    flex-flow: column nowrap;
  }
</style>
