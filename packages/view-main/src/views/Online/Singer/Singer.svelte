<script lang="ts">
  import { untrack } from 'svelte'
  import { resourceList } from '@/modules/extension/reactive.svelte'
  import { query, getLocation } from '@/plugins/routes'
  import { getSourceId } from '../shared.svelte'
  import { pushRoute } from '@/modules/resource/actions'
  import { singer } from '@/shared/ipc/resource'
  import { getSingerMusics } from '@/modules/resource/singer'
  import { playMusicCollection } from '@/modules/player/store/playerActions'
  import { updateSetting } from '@/modules/setting/store/action'
  import { getRandom } from '@/shared'
  import MusicList from '@/components/common/MusicList/MusicList.svelte'
  import Pagination from '@/components/material/Pagination.svelte'
  import Empty from '@/components/material/Empty.svelte'
  import Btn from '@/components/base/Btn.svelte'
  import { t } from '@/plugins/i18n'

  const source = $derived($resourceList.resources.singer?.find((item) => getSourceId(item) === $query.s))
  const id = $derived($query.id ?? '')
  const collectionId = $derived(source ? new URLSearchParams({ s: getSourceId(source), id }).toString() : '')
  let result = $state<AnyListen.IPCExtension.SingerDetailResult>({ list: [], total: 0, page: 1, limit: 30, info: { id: '', name: '' } })
  let loading = $state(false)
  let error = $state(false)
  let retry = $state(0)
  let request = 0

  $effect(() => {
    const active = source
    const singerId = id
    const page = Math.max(1, Number($query.p) || 1)
    retry
    const token = ++request
    if (!active || !singerId) return
    untrack(() => {
      loading = true
      error = false
      void singer({ extensionId: active.extensionId, source: active.id, id: singerId, page, limit: 30 })
        .then((data) => { if (token === request) result = data })
        .catch(() => { if (token === request) error = true })
        .finally(() => { if (token === request) loading = false })
    })
    return () => { request++ }
  })

  const play = async (music: AnyListen.Music.MusicInfo, random?: boolean) => {
    const active = source!
    const singerId = id
    const listId = collectionId
    const token = ++request
    loading = true
    error = false
    try {
      const list = await getSingerMusics(active.extensionId, active.id, singerId)
      if (token !== request) return
      const index = random === true ? getRandom(0, list.length) : random === false ? 0 : list.findIndex((item) => item.id === music.id)
      if (index < 0 || !list.length) return
      if (random !== undefined) await updateSetting({ 'player.togglePlayMethod': random ? 'random' : 'listLoop' })
      await playMusicCollection(listId, list, index, 'singer')
    } catch {
      if (token === request) error = true
    } finally {
      if (token === request) loading = false
    }
  }
</script>

<div class="singer-detail">
  {#if source && id}
    <MusicList list={result.list} {loading} {error} source="singer"
      listinfo={{ id: collectionId, name: result.info.name, pic: result.info.img, type: 'online', listMeta: { extensionId: source.extensionId, source: source.id } }}
      onplaymusic={(music, random) => { void play(music, random) }}
      onreload={() => { retry++ }} />
    <div class="pagination">
      <Pagination count={result.total} page={result.page} limit={result.limit} onclick={(page) => {
        pushRoute('/online', { ...getLocation().query, p: page })
      }} />
    </div>
  {:else}
    <Btn onclick={() => { pushRoute('/online', { t: 'search', qt: 'singer' }) }}>{$t('singer_search')}</Btn>
    {#if id}<Empty label={$t('singer_unsupported')} />{/if}
  {/if}
</div>

<style lang="less">
  .singer-detail { display: flex; flex: auto; flex-direction: column; min-width: 0; min-height: 0; }
  .pagination { display: flex; justify-content: center; padding: 10px 0; }
  @media (max-width: 600px) {
    .singer-detail :global(.header .left) { width: 64px; height: 64px; flex: none; }
    .singer-detail :global(.header .right) { min-width: 0; }
    .singer-detail :global(.control-btns .btns) { flex-wrap: wrap; flex-shrink: 1; }
  }
</style>
