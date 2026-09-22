/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { sortSingle, getIntv, trimStr, filterStr } from './search/normalize'

import { services, type ResourceServices } from './shared'

export const createMusicSearch = (services: ResourceServices) => {
  const musicSearch = async ({
    extensionId,
    source,
    name,
    artist,
    page,
    limit,
  }: {
    extensionId: string
    source: string
    name: string
    artist?: string
    page: number
    limit?: number
  }): Promise<AnyListen.IPCResource.MusicListResult> => {

    if (!name.trim().length) {
      return {
        list: [],
        total: 0,
        limit: limit ?? 30,
        page: page ?? 1,
      }
    }
    return services.extensionSerive
      .resourceAction('musicSearch', {
        extensionId,
        source,
        name,
        artist,
        limit,
        page,
      })
      .then(({ list, total, limit, page }) => ({ list, total, limit, page }))
  }

  type FindMusicType = Omit<AnyListen.Music.MusicInfoOnline, 'name'> & {
    name: null | string
    fSinger?: string
    fMusicName?: string
    fAlbumName?: string
    fInterval?: number
  }
  const findMusic = async ({
    extensionId,
    name,
    singer,
    albumName,
    interval,
    source: s,
    // TODO: strict mode
    strict = true,
  }: {
    extensionId: string
    source: string
    name: string
    singer?: string
    albumName?: string
    interval?: string | number | null
    strict?: boolean
  }): Promise<AnyListen.Music.MusicInfoOnline | null> => {
    // TODO: auto reversal of singer and name
    const list = await musicSearch({
      extensionId,
      source: s,
      name,
      artist: singer,
      page: 1,
      limit: 20,
    }).catch((err) => {
      console.error(err)
      return null
    })
    if (!list) return null

    const sortMusic = (arr: FindMusicType[], callback: (item: FindMusicType) => boolean) => {
      const tempResult = []
      for (let i = arr.length - 1; i > -1; i--) {
        const item = arr[i]
        if (callback(item)) {
          delete item.fSinger
          delete item.fMusicName
          delete item.fAlbumName
          delete item.fInterval
          tempResult.push(item)
          arr.splice(i, 1)
        }
      }
      tempResult.reverse()
      return tempResult
    }
    const fMusicName = filterStr(name).toLowerCase()
    const fSinger = filterStr(sortSingle(singer)).toLowerCase()
    const fAlbumName = filterStr(albumName).toLowerCase()
    const fInterval = getIntv(interval)
    const isEqualsInterval = (intv: number) => Math.abs((fInterval || intv) - (intv || fInterval)) < (strict ? 5 : 30)
    const isIncludesName = (name: string) => fMusicName.includes(name) || name.includes(fMusicName)
    const isIncludesSinger = (singer: string) => (fSinger ? fSinger.includes(singer) || singer.includes(fSinger) : true)
    const isEqualsAlbum = (album: string) => (fAlbumName ? fAlbumName == album : true)

    const handleSource = (source: { list: AnyListen.Music.MusicInfoOnline[]; total: number }) => {
      for (const _item of source.list) {
        const item = _item as FindMusicType
        item.name = trimStr(item.name!)
        item.singer = trimStr(item.singer)
        item.fSinger = filterStr(sortSingle(item.singer).toLowerCase())
        item.fMusicName = filterStr(String(item.name ?? '').toLowerCase())
        item.fAlbumName = filterStr(String(item.meta.albumName ?? '').toLowerCase())
        item.fInterval = getIntv(item.interval)

        if (!isEqualsInterval(item.fInterval)) {
          item.name = null
          continue
        }
        if (item.fMusicName == fMusicName && isIncludesSinger(item.fSinger)) return item
      }
      for (const item of source.list as FindMusicType[]) {
        if (item.name == null) continue
        if (item.fSinger == fSinger && isIncludesName(item.fMusicName!)) return item
      }
      for (const item of source.list as FindMusicType[]) {
        if (item.name == null) continue
        if (isEqualsAlbum(item.fAlbumName!) && isIncludesSinger(item.fSinger!) && isIncludesName(item.fMusicName!)) return item
      }
      return null
    }

    const result = [handleSource(list)].filter((s) => s != null)
    const newResult = []
    if (result.length) {
      newResult.push(
        ...sortMusic(result, (item) => item.fSinger == fSinger && item.fMusicName == fMusicName && item.interval == interval)
      )
      newResult.push(
        ...sortMusic(result, (item) => item.fMusicName == fMusicName && item.fSinger == fSinger && item.fAlbumName == fAlbumName)
      )
      newResult.push(...sortMusic(result, (item) => item.fSinger == fSinger && item.fMusicName == fMusicName))
      newResult.push(...sortMusic(result, (item) => item.fMusicName == fMusicName && item.interval == interval))
      newResult.push(...sortMusic(result, (item) => item.fSinger == fSinger && item.interval == interval))
      newResult.push(...sortMusic(result, (item) => item.interval == interval))
      newResult.push(...sortMusic(result, (item) => item.fMusicName == fMusicName))
      newResult.push(...sortMusic(result, (item) => item.fSinger == fSinger))
      newResult.push(...sortMusic(result, (item) => item.fAlbumName == fAlbumName))
      for (const item of result) {
        delete item.fSinger
        delete item.fMusicName
        delete item.fAlbumName
        delete item.fInterval
      }
      newResult.push(...result)
    }

    return (newResult as unknown as AnyListen.Music.MusicInfoOnline[])[0] ?? null
  }
  return { musicSearch, findMusic }
}

export const { musicSearch, findMusic } = createMusicSearch(services)
