import { createResources, initResources as initResourcesModule } from '@any-listen/app/modules/resources'
import { resourceState, closeService } from '@any-listen/app/modules/resources/shared'

import { workers } from '@/app/worker'

let resources: ReturnType<typeof createResources>

export const initResources = async () => {
  await initResourcesModule(workers.extensionService)
  resources = createResources(workers.extensionService, resourceState)
}

export const closeResources = () => {
  resources?.close()
  closeService()
}
export const musicComment = (...args: Parameters<typeof resources.musicComment>) => resources.musicComment(...args)
export const tipSearch = (...args: Parameters<typeof resources.tipSearch>) => resources.tipSearch(...args)
export const hotSearch = (...args: Parameters<typeof resources.hotSearch>) => resources.hotSearch(...args)
export const findMusic = (...args: Parameters<typeof resources.findMusic>) => resources.findMusic(...args)
export const musicSearch = (...args: Parameters<typeof resources.musicSearch>) => resources.musicSearch(...args)
export const songlist = (...args: Parameters<typeof resources.songlist>) => resources.songlist(...args)
export const songlistSearch = (...args: Parameters<typeof resources.songlistSearch>) => resources.songlistSearch(...args)
export const songlistDetail = (...args: Parameters<typeof resources.songlistDetail>) => resources.songlistDetail(...args)
export const songlistSorts = (...args: Parameters<typeof resources.songlistSorts>) => resources.songlistSorts(...args)
export const songlistTags = (...args: Parameters<typeof resources.songlistTags>) => resources.songlistTags(...args)
export const songlistDetailAll = (...args: Parameters<typeof resources.songlistDetailAll>) => resources.songlistDetailAll(...args)
export const topSongs = (...args: Parameters<typeof resources.topSongs>) => resources.topSongs(...args)
export const topSongsDate = (...args: Parameters<typeof resources.topSongsDate>) => resources.topSongsDate(...args)
export const topSongsDetail = (...args: Parameters<typeof resources.topSongsDetail>) => resources.topSongsDetail(...args)
export const topSongsDetailAll = (...args: Parameters<typeof resources.topSongsDetailAll>) => resources.topSongsDetailAll(...args)
export const getMusicLyric = (...args: Parameters<typeof resources.getMusicLyric>) => resources.getMusicLyric(...args)
export const getMusicLyricByExtensionSource = (...args: Parameters<typeof resources.getMusicLyricByExtensionSource>) =>
  resources.getMusicLyricByExtensionSource(...args)
export const getLyric = (...args: Parameters<typeof resources.getLyric>) => resources.getLyric(...args)
export const lyricSearch = (...args: Parameters<typeof resources.lyricSearch>) => resources.lyricSearch(...args)
export const getMusicPic = (...args: Parameters<typeof resources.getMusicPic>) => resources.getMusicPic(...args)
export const getMusicPicByExtensionSource = (...args: Parameters<typeof resources.getMusicPicByExtensionSource>) =>
  resources.getMusicPicByExtensionSource(...args)
export const musicPicSearch = (...args: Parameters<typeof resources.musicPicSearch>) => resources.musicPicSearch(...args)
export const getMusicUrl = (...args: Parameters<typeof resources.getMusicUrl>) => resources.getMusicUrl(...args)
export const getMusicUrlByExtensionSource = (...args: Parameters<typeof resources.getMusicUrlByExtensionSource>) =>
  resources.getMusicUrlByExtensionSource(...args)
