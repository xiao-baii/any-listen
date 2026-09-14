import type { ExtensionSeriveTypes } from '../worker/utils'
import { createComments } from './comment'
import { createLyrics } from './lyric'
import { createMusicPictures } from './musicPic'
import { createMusicSearch } from './musicSearch'
import { createMusicUrls } from './musicUrl'
import { createFallbackSearch } from './search/music'
import { createSearchMeta } from './searchMeta'
import type { ResourceState } from './shared'
import { createSonglists } from './songlist'
import { createMusicFinder } from './tools'
import { createTopSongs } from './topSongs'
import { createSourceSelector } from './utils'

export const createResources = (extension: ExtensionSeriveTypes, state: ResourceState) => {
  let closed = false
  const services = {
    get extensionSerive() {
      if (closed) throw new Error('Resources are closed')
      return extension
    },
  }
  const selector = createSourceSelector(state)
  const finder = createMusicFinder(createFallbackSearch(services).findMusic, selector)
  return {
    ...createComments(services),
    ...createSearchMeta(services),
    ...createMusicSearch(services),
    ...createSonglists(services),
    ...createTopSongs(services),
    ...createLyrics(services, finder.findMusic, selector.getExtSource),
    ...createMusicPictures(services, finder.findMusic, selector.getExtSource),
    ...createMusicUrls(services, finder.findMusic, selector.getExtSource),
    close() {
      closed = true
      state.resources = {}
    },
  }
}
