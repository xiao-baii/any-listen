import { singerFormat } from './tools'

export const splitSingers = (singer: string) => [
  ...new Set(
    singerFormat(singer)
      .split('、')
      .map((s) => s.trim())
      .filter(Boolean)
  ),
]

export const getSingerOptions = (list: AnyListen.Music.MusicInfo[]) => {
  const counts = new Map<string, number>()
  for (const music of list) {
    for (const singer of splitSingers(music.singer)) counts.set(singer, (counts.get(singer) ?? 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, count }))
}

export const filterSinger = (list: AnyListen.Music.MusicInfo[], singer: string) =>
  singer ? list.filter((music) => splitSingers(music.singer).includes(singer)) : list
