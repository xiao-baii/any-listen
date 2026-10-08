<script lang="ts">
  import { untrack } from 'svelte'
  import { query, getLocation } from '@/plugins/routes'
  import { pushRoute } from '@/modules/resource/actions'
  import { singerSearch } from '@/shared/ipc/resource'
  import type { SourceType } from '../../shared.svelte'
  import Loading from '@/components/base/Loading.svelte'
  import Image from '@/components/base/Image.svelte'
  import Empty from '@/components/material/Empty.svelte'
  import Pagination from '@/components/material/Pagination.svelte'

  let { source }: { source: SourceType } = $props()
  let result = $state<AnyListen.IPCExtension.ListCommonResult<AnyListen.Resource.SingerItem>>({ list: [], total: 0, page: 1, limit: 30 })
  let loading = $state(false)
  let error = $state(false)
  let retry = $state(0)

  $effect(() => {
    const keyword = ($query.q ?? '').trim()
    const page = Math.max(1, Number($query.p) || 1)
    retry
    let current = true
    if (!keyword) { result = { list: [], total: 0, page: 1, limit: 30 }; loading = false; error = false; return }
    untrack(() => {
      loading = true
      error = false
      void singerSearch({ extensionId: source.extensionId, source: source.id, keyword, page, limit: 30 })
        .then((data) => { if (current) result = data })
        .catch(() => { if (current) error = true })
        .finally(() => { if (current) loading = false })
    })
    return () => { current = false }
  })
</script>

<div class="results">
  <div class="scroll cards">
    {#each result.list as item (item.id)}
      <button class="singer" onclick={() => {
        pushRoute('/online', { t: 'singer', s: source.sId, id: item.id })
      }}>
        <Image src={item.img} alt="" width="56px" height="56px" />
        <span title={item.name}>{item.name}</span>
      </button>
    {:else}
      {#if !loading && !error}<Empty />{/if}
    {/each}
  </div>
  <div class="pagination">
    <Pagination count={result.total} page={result.page} limit={result.limit} onclick={(page) => {
      pushRoute('/online', { ...getLocation().query, p: page })
    }} />
  </div>
  <Loading {loading} {error} onreload={() => { retry++ }} />
</div>

<style lang="less">
  .results { position: relative; display: flex; flex: auto; flex-direction: column; min-width: 0; min-height: 0; }
  .cards { flex: auto; overflow: auto; padding: 0 12px; }
  .singer { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px; color: inherit; background: transparent; border: 0; text-align: left; cursor: pointer; }
  .singer:hover { background: var(--color-primary-background-hover); }
  .singer span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .singer :global(.pic) { flex: none; }
  .pagination { display: flex; justify-content: center; padding: 10px 0; }
</style>
