import { onConnected } from '@/modules/app/shared'

import { ipc } from '../ipc'

export const getAllList: AnyListen.IPC.ServerIPC['getAllUserLists'] = async () => {
  return ipc.getAllUserLists()
}
export const getListMusics: AnyListen.IPC.ServerIPC['getListMusics'] = async (id) => {
  return ipc.getListMusics(id)
}
export const checkListExistMusic: AnyListen.IPC.ServerIPC['checkListExistMusic'] = async (id, musicId) => {
  return ipc.checkListExistMusic(id, musicId)
}
export const getListCover: AnyListen.IPC.ServerIPC['getListCover'] = async (listId) => {
  return ipc.getListCover(listId)
}
export const getMusicExistListIds: AnyListen.IPC.ServerIPC['getMusicExistListIds'] = async (id) => {
  return ipc.getMusicExistListIds(id)
}

export const sendListAction: AnyListen.IPC.ServerIPC['listAction'] = async (action) => {
  return ipc.listAction(action)
}

let selectionWrites = { confirmedId: null as string | null, tail: Promise.resolve() }
onConnected(() => { selectionWrites = { confirmedId: null, tail: Promise.resolve() } })

export const getListPrevSelectId: AnyListen.IPC.ServerIPC['getListPrevSelectId'] = async () => ipc.getListPrevSelectId()
export const saveListPrevSelectId: AnyListen.IPC.ServerIPC['saveListPrevSelectId'] = async (id) => {
  const connection = selectionWrites
  const task = connection.tail.then(async () => {
    if (connection !== selectionWrites || connection.confirmedId === id) return
    await ipc.saveListPrevSelectId(id)
    connection.confirmedId = id
  })
  connection.tail = task.catch(() => {})
  return task
}
export const getListScrollPosition: AnyListen.IPC.ServerIPC['getListScrollPosition'] = async () => {
  return ipc.getListScrollPosition()
}
export const saveListScrollPosition: AnyListen.IPC.ServerIPC['saveListScrollPosition'] = async (id, position) => {
  return ipc.saveListScrollPosition(id, position)
}

export const addFolderMusics: AnyListen.IPC.ServerIPC['addFolderMusics'] = async (listId, filePaths, onEnd) => {
  return ipc.addFolderMusics(listId, filePaths, onEnd)
}
export const cancelAddFolderMusics: AnyListen.IPC.ServerIPC['cancelAddFolderMusics'] = async (taskId) => {
  return ipc.cancelAddFolderMusics(taskId)
}

export const syncUserList: AnyListen.IPC.ServerIPC['syncUserList'] = async (id) => {
  return ipc.syncUserList(id)
}

export const parseMusicMetadata: AnyListen.IPC.ServerIPC['parseMusicMetadata'] = async (listId, musicInfo) => {
  return ipc.parseMusicMetadata(listId, musicInfo)
}

export const sortListMusics: AnyListen.IPC.ServerIPC['sortListMusics'] = async (id, list, type) => {
  return ipc.sortListMusics(id, list, type)
}

// export const importLocalFile: AnyListen.IPC.ServerIPC['importLocalFile'] = async(listId) => {
//   return ipc.importLocalFile(listId)
// }
