import { SINGERS_RXP } from '@any-listen/common/constants'

export const sortSingle = (singer?: string) =>
  typeof singer == 'string' && SINGERS_RXP.test(singer)
    ? singer
        .split(SINGERS_RXP)
        .map((s) => s.trim())
        .filter((s) => s)
        .sort((a, b) => a.localeCompare(b))
        .join('、')
    : singer || ''
export const getIntv = (interval?: string | number | null) => {
  if (!interval) return 0
  if (typeof interval === 'number') return interval
  const intvArr = interval.split(':')
  let intv = 0
  let unit = 1
  while (intvArr.length) {
    intv += parseInt(intvArr.pop()!) * unit
    unit *= 60
  }
  return intv
}
export const trimStr = (str?: string) => (typeof str == 'string' ? str.trim() : str || '')
export const filterStr = (str?: string) =>
  typeof str == 'string' ? str.replace(/\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||\/|\]|\[|!|！/g, '') : String(str || '')
