<script lang="ts">
  import MusicList from '@/components/common/MusicList/MusicList.svelte'
  import { getLocation, location, query, replace } from '@/plugins/routes'
  import { onConnected } from '@/modules/app/shared'
  import { getListMusics } from '@/modules/musicLibrary/actions'
  import { musicLibraryEvent } from '@/modules/musicLibrary/store/event'
  import type { ListInfo } from '@/components/common/MusicList/type'
  import { useListCover, userListInited, userListsAll } from '@/modules/musicLibrary/reactive.svelte'
  import { dateFormat } from '@/shared'
  import {
    getListScrollPosition,
    saveListScrollPosition,
    userListExist,
    sortListMusics,
    getListPrevSelectId,
    saveListPrevSelectId,
  } from '@/modules/musicLibrary/store/actions'
  import { type ComponentExports, tick, untrack } from 'svelte'
  import { LIST_IDS } from '@any-listen/common/constants'
  import { resourceList } from '@/modules/extension/reactive.svelte'
  import { LIST_PIC_ICON } from '@/shared/constants'

  let list = $state.raw<AnyListen.Music.MusicInfo[]>([])
  let musicList = $state<ComponentExports<typeof MusicList> | null>(null)

  const getTargetActiveListInfo = (allList: typeof $userListsAll, activeId: string) => {
    return allList.find((l) => l.id == activeId)
  }
  const buildActiveListInfo = (
    resourceList: AnyListen.Extension.ResourceList,
    info?: AnyListen.List.MyListInfo,
    listCover?: string | null
  ) => {
    if (!info) return undefined
    switch (info.type) {
      case 'default':
      case 'general':
        return {
          id: info.id,
          name: info.name,
          createTime: info.type == 'default' ? '' : dateFormat(info.meta.createTime, 'Y-M-D'),
          playCount: info.meta.playCount,
          pic: info.type == 'default' ? '' : info.meta.pic || listCover || '',
          picIcon: LIST_PIC_ICON[info.id as keyof typeof LIST_PIC_ICON],
          type: info.type,
        } satisfies ListInfo
      case 'local':
        return {
          id: info.id,
          name: info.name,
          createTime: dateFormat(info.meta.createTime, 'Y-M-D'),
          playCount: info.meta.playCount,
          pic: info.meta.pic || listCover || '',
          type: info.type,
          listMeta: {
            deviceId: info.meta.deviceId,
          },
          getSortTimeFn() {
            return async (list, type) => {
              return sortListMusics(info.id, list, type)
            }
          },
        } satisfies ListInfo
      case 'online':
      case 'remote':
        return {
          id: info.id,
          name: info.name,
          createTime: dateFormat(info.meta.createTime, 'Y-M-D'),
          playCount: info.meta.playCount,
          pic: info.meta.pic || listCover || '',
          type: info.type,
          listMeta: {
            extensionId: info.meta.extensionId,
            source: info.meta.source,
          },
          getSortTimeFn() {
            if (
              info.type === 'remote' &&
              resourceList.listProvider.find((l) => l.extensionId === info.meta.extensionId && l.id === info.meta.source)
                ?.fileSortable
            ) {
              return async (list, type) => {
                return sortListMusics(info.id, list, type)
              }
            }
            return null
          },
        } satisfies ListInfo
    }
  }
  const targetListInfo = $derived(getTargetActiveListInfo($userListsAll, $query.id))
  const listCover = $derived(useListCover(targetListInfo))
  const listInfo = $derived(buildActiveListInfo($resourceList, targetListInfo, listCover.val))
  const selectionExists = $derived($userListInited && !!targetListInfo)

  const isCurrentRoute = (route: string, id: string, mid: string) => {
    const current = getLocation()
    return current.location === route && current.query.id === id && current.query.mid === mid
  }

  let currentId = ''
  let currentLocation = ''
  let scrollReady = false
  const handleScroll = (pos: number) => {
    if (!scrollReady || $location !== currentLocation || $query.id !== currentId) return
    void saveListScrollPosition(currentId, pos)
  }

  $effect(() => {
    const route = $location
    const { id, mid } = $query
    currentLocation = route
    if (!selectionExists || id !== currentId) {
      currentId = id
      scrollReady = false
      list = []
    }
    if (!selectionExists) return

    let active = true
    let request = 0
    let restoreScroll = !scrollReady || !!mid
    if (restoreScroll) scrollReady = false
    const isCurrent = (version: number) => active && request === version &&
      isCurrentRoute(route, id, mid) && $userListInited && userListExist(id)
    const load = () => {
      const version = ++request
      const position = restoreScroll ? getListScrollPosition(id).catch(() => 0) : 0
      void Promise.all([getListMusics(id), position]).then(async ([songs, pos]) => {
        if (!isCurrent(version)) return
        list = [...songs]
        if (!restoreScroll) return

        await tick()
        if (!isCurrent(version)) return
        const index = mid ? songs.findIndex((music) => music.id === mid) : -1
        if (index < 0) musicList?.setScrollPosition(pos)
        else musicList?.setScrollIndex(index)
        restoreScroll = false
        scrollReady = true
        if (mid) await replace(`/library?id=${id}`)
      }).catch((error: unknown) => console.warn('Failed to load playlist view', error))
    }
    if (restoreScroll) untrack(load)
    const unsub = musicLibraryEvent.on('listMusicChanged', (ids) => {
      if (ids.includes(id) && userListExist(id)) load()
    })
    const unsub2 = musicLibraryEvent.on('listMusicUpdated', (updateInfo) => {
      if (updateInfo.has(id) && userListExist(id)) load()
    })

    return () => {
      active = false
      unsub()
      unsub2()
    }
  })

  $effect(() => {
    const route = $location
    const { id, mid } = $query
    if (!$userListInited) return
    let active = true
    const isCurrent = () => active && isCurrentRoute(route, id, mid) && $userListInited
    if (selectionExists) {
      const save = () => {
        if (!isCurrent() || !userListExist(id)) return
        void saveListPrevSelectId(id).catch((error: unknown) => console.warn('Failed to save playlist selection', error))
      }
      untrack(save)
      const unsubscribe = onConnected(save)
      return () => {
        active = false
        unsubscribe()
      }
    }

    void getListPrevSelectId().catch(() => null).then((prevId) => {
      if (!isCurrent() || userListExist(id)) return
      const target = prevId && userListExist(prevId) ? prevId : LIST_IDS.LOVE
      return replace(`/library?id=${target}`)
    }).catch((error: unknown) => console.warn('Failed to restore playlist selection', error))
    return () => { active = false }
  })
</script>

<div class="view-container container">
  {#if listInfo}
    <MusicList bind:this={musicList} listinfo={listInfo} {list} onscroll={handleScroll} />
  {/if}
</div>

<style lang="less">
  .container {
    position: relative;
    display: flex;
    flex: auto;
    flex-flow: column nowrap;
    // border-right: 1px solid var(--color-border);
    // background: #fff;
    // overflow: hidden;
    :global(.slider-content) {
      width: 200px;
    }
  }
  // .list {
  //   flex: auto;
  // }
</style>
