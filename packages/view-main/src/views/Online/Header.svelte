<script lang="ts">
  import Tab from '@/components/base/Tab.svelte'
  import { i18n } from '@/plugins/i18n'
  import { tabIcons, viewResourceMap, viewTypes, urlParamKeyMap } from './shared.svelte'
  import { resourceList } from '@/modules/extension/reactive.svelte'
  import { pushRoute } from '@/modules/resource/actions'
  import { query } from '@/plugins/routes'

  let { activeview }: { activeview: (typeof viewTypes)[number] } = $props()
  const typeList = $derived.by(() => {
    const res = Object.keys($resourceList.resources)
    return viewTypes
      .filter((t) => {
        return viewResourceMap[t].some((r) => res.includes(r))
      })
      .map((t) => {
        return { id: t, icon: tabIcons[t], label: i18n.t(`online__type_${t}`) }
      })
  })
</script>

<header class="header">
  <Tab
    list={typeList}
    itemkey="id"
    itemlabel="label"
    itemicon="icon"
    value={activeview}
    min
    onchange={(item) => {
      pushRoute('/online', { [urlParamKeyMap.type]: item.id, [urlParamKeyMap.source]: $query[urlParamKeyMap.source] })
    }}
  />
  <div id="online-header-right"></div>
</header>

<style lang="less">
  .header {
    display: flex;
    flex: none;
    flex-flow: row nowrap;
    align-items: center;
    justify-content: space-between;
    padding: 0 15px;
    // padding: 8px 0;
    // background-color: var(--color-primary-light-400-alpha-800);
    // border-radius: @radius-border;

    // h2 {
    //   font-size: 18px;
    //   padding: 0 15px;
    // }
  }
</style>
