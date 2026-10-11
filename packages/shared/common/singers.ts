import { singerFormat } from './tools'

export const splitSingers = (singer: string) => [
  ...new Set(
    singerFormat(singer)
      .split('、')
      .map((s) => s.trim())
      .filter(Boolean)
  ),
]

export const filterSinger = (list: AnyListen.Music.MusicInfo[], singer: string) => {
  const query = singer.trim().toLowerCase()
  return query ? list.filter((music) => splitSingers(music.singer).some((name) => name.toLowerCase().includes(query))) : list
}
