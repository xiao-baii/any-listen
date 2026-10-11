<script lang="ts">
  import { resourceList } from '@/modules/extension/reactive.svelte'
  import { getSourceId, type ResourceListType } from '../../shared.svelte'
  import { query } from '@/plugins/routes'
  import { pushRoute } from '@/modules/resource/actions'
  import Source from '../../Source.svelte'
  import Empty from '@/components/material/Empty.svelte'
  import { t } from '@/plugins/i18n'
  import List from './List.svelte'

  let { sourceList }: { sourceList: NonNullable<ResourceListType['singerSearch']> } = $props()
  const sources = $derived(sourceList.filter((source) =>
    $resourceList.resources.singer?.some((detail) => getSourceId(detail) === getSourceId(source))
  ).map((source) => ({ ...source, sId: getSourceId(source) })))
  const active = $derived(sources.find((source) => source.sId === $query.s) ?? sources[0])
</script>

<div class="singer-search">
  {#if active}
    <Source list={sources} active={active.sId} onchange={(source) => {
      pushRoute('/online', { t: 'search', qt: 'singer', q: $query.q ?? '', s: source.sId })
    }} />
    {#key active.sId}<List source={active} />{/key}
  {:else}
    <Empty label={$t('singer_unsupported')} />
  {/if}
</div>

<style lang="less">
  .singer-search {
    display: flex;
    flex-flow: row nowrap;
    height: 100%;
    min-height: 0;
    padding-top: 10px;
  }
</style>
