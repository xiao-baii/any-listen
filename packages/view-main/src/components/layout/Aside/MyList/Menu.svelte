<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { t } from '@/plugins/i18n'
  import Menu, { type MenuItem, type MenuList } from '@/components/base/Menu.svelte'
  import { LIST_IDS } from '@any-listen/common/constants'
  import { importLocalFile, importLocalFileFolder, removeUserList, syncUserList } from './action'
  import { showListEditModal } from '@/components/apis/listEditModal'
  import { musicLibraryEvent } from '@/modules/musicLibrary/store/event'
  import { appState } from '@/modules/app/store/state'
  import { GENERAL_LIST_TYPES } from '@/shared/constants'
  import { account } from '@/accounts/state.svelte'

  let {
    onhide,
  }: {
    onhide?: () => void
  } = $props()

  type MenuType =
    | 'create'
    | 'edit'
    | 'sort'
    | 'duplicate'
    | 'local_file'
    | 'local_file_folder'
    | 'update'
    | 'sourceDetail'
    | 'import'
    | 'export'
    | 'remove'
  let menuVisible = $state.raw(false)
  let menuLocation = $state.raw({ x: 0, y: 0 })
  let menus = $state.raw<MenuList<MenuType>>([])
  let info: AnyListen.List.MyListInfo | null
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  let fetchingListStatus = new Set<string>()

  const setMenu = () => {
    if (!info) {
      menus = [{ action: 'create', label: $t('user_list_menu__create') }]
      return
    }
    let edit = false
    // let update = false
    let remove = false
    // let local_file = !listState.fetchingListStatus[listInfo.id]
    // let userList: AnyListen.List.UserListInfo
    switch (info.id) {
      case LIST_IDS.DEFAULT:
      case LIST_IDS.LOVE:
        break
      default:
        // userList = info as AnyListen.List.UserListInfo
        edit = true
        remove = true
        break
    }

    const fetching = fetchingListStatus.has(info.id)
    const disabledUpdate = fetching || (info.type == 'local' && info.meta.deviceId != appState.machineId)
    const isGeneral = GENERAL_LIST_TYPES.includes(info.type)

    menus = (
      [
        !isGeneral && { action: 'update', disabled: disabledUpdate, label: $t('user_list_menu__sync') },
        { action: 'create', label: $t('user_list_menu__create') },
        { action: 'edit', disabled: !edit, label: $t('user_list_menu__edit') },
        isGeneral && !account.enabled && { action: 'local_file', disabled: fetching, label: $t('user_list_menu__select_local_file') },
        isGeneral && !account.enabled && { action: 'local_file_folder', disabled: fetching, label: $t('user_list_menu__select_local_file_folder') },
        // null,
        // { action: 'sort', label: $t('user_list_menu__sort_list') },
        // { action: 'duplicate', label: $t('user_list_menu__duplicate') },
        // { action: 'sourceDetail', label: $t('user_list_menu__source_detail') },
        // { action: 'import', label: $t('user_list_menu__import') },
        // { action: 'export', label: $t('user_list_menu__export') },
        null,
        { action: 'remove', disabled: !remove || fetching, label: $t('user_list_menu__remove') },
      ] satisfies Array<MenuList<MenuType>[number] | false>
    ).filter((m) => m !== false)
  }

  export const show = async (selectInfo: AnyListen.List.MyListInfo | null, position: { x: number; y: number }) => {
    info = selectInfo
    menuLocation = position
    setMenu()
    await tick()
    menuVisible = true
  }

  const handleClick = (menu: MenuItem<MenuType>) => {
    switch (menu.action) {
      case 'create':
        void showListEditModal(info?.id)
        break
      case 'edit':
        void showListEditModal(info!.id, true)
        break
      case 'local_file':
        void importLocalFile(info!)
        break
      case 'local_file_folder':
        void importLocalFileFolder(info!)
        break
      case 'update':
        void syncUserList(info!)
        break
      case 'remove':
        void removeUserList(info!)
        break

      default:
        break
    }
    menuVisible = false
  }

  onMount(() => {
    const unsub = musicLibraryEvent.on('fetchingListStatusUpdated', (_id, status) => {
      if (status) fetchingListStatus.add(_id)
      else fetchingListStatus.delete(_id)
      if (info?.id != _id) return
      setMenu()
    })

    return () => {
      unsub()
      fetchingListStatus.clear()
    }
  })
</script>

<Menu bind:visible={menuVisible} {menus} location={menuLocation} onclick={handleClick} {onhide} />
