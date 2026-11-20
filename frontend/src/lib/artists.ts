// 歌手類欄位（Artist / AlbumArtist / Composer / Performer）的標籤輸入共用邏輯

export type ArtistRole = 'artist' | 'albumartist' | 'composer' | 'performer'

export const SORT_FIELD: Record<ArtistRole, string> = {
  artist: 'artistsort',
  albumartist: 'albumartistsort',
  composer: 'composersort',
  performer: 'performersort',
}

export interface ArtistEntry {
  name: string
  /** 音樂庫中最常與這個名字配對的排序名稱；沒有可配對的資料時為空字串 */
  sort: string
  roles: Partial<Record<ArtistRole, number>>
}

/** 一個歌手標籤。sort 為 null 代表排序名稱尚未決定（等待音樂庫或拼音轉換）。 */
export interface ArtistChip {
  id: string
  name: string
  sort: string | null
}

export type ArtistDirectory = Map<string, ArtistEntry>

let nextChipId = 0
export const makeChip = (name: string, sort: string | null): ArtistChip => ({
  id: `chip-${nextChipId++}`,
  name,
  sort,
})

export const splitNames = (value: unknown): string[] => {
  if (value === null || value === undefined) return []
  const items = Array.isArray(value) ? value : String(value).split(';')
  return items.map(item => String(item).trim()).filter(Boolean)
}

/**
 * 由歌曲現有的名字與排序欄位建立標籤。
 * 兩邊數量一致時沿用歌曲原本的排序名稱，避免只改其他欄位時排序被悄悄改掉；
 * 對不上時全部標記為待決定，之後由音樂庫或拼音重新產生。
 */
export const chipsFromTags = (names: unknown, sorts: unknown): ArtistChip[] => {
  const nameList = splitNames(names)
  const sortList = splitNames(sorts)
  const aligned = nameList.length === sortList.length
  return nameList.map((name, index) => makeChip(name, aligned ? sortList[index] : null))
}

export const joinNames = (chips: ArtistChip[]) => chips.map(chip => chip.name).join(';')
export const joinSorts = (chips: ArtistChip[]) => chips.map(chip => chip.sort ?? '').join(';')

export async function fetchArtistDirectory(): Promise<ArtistDirectory> {
  const response = await fetch('/api/tags/artists')
  if (!response.ok) throw new Error('無法載入歌手清單')
  const entries: ArtistEntry[] = await response.json()
  return new Map(entries.map(entry => [entry.name, entry]))
}

export async function fetchPinyin(text: string): Promise<string> {
  const response = await fetch('/api/tools/pinyin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  const data = await response.json()
  if (!response.ok || typeof data.result !== 'string') throw new Error('拼音轉換失敗')
  return data.result
}

/** 新加入的名字：音樂庫已有排序名稱就沿用，否則轉換拼音。 */
export async function resolveSort(name: string, directory: ArtistDirectory | null): Promise<string> {
  const known = directory?.get(name)?.sort
  if (known) return known
  return fetchPinyin(name)
}

/** 存檔前補齊所有還沒決定的排序名稱。 */
export async function resolveChips(chips: ArtistChip[], directory: ArtistDirectory | null): Promise<ArtistChip[]> {
  return Promise.all(
    chips.map(async chip => (chip.sort === null ? { ...chip, sort: await resolveSort(chip.name, directory) } : chip)),
  )
}

/**
 * 依輸入文字列出建議：名字開頭吻合 > 名字包含 > 排序名稱（多為拼音）開頭吻合 > 排序名稱包含；
 * 同等級時，在目前欄位用過的優先，再依總使用次數排列。已選的名字不列出。
 */
export function suggestArtists(
  directory: ArtistDirectory | null,
  query: string,
  role: ArtistRole,
  exclude: Set<string>,
  limit = 8,
): ArtistEntry[] {
  if (!directory) return []
  const q = query.trim().toLowerCase()
  const ranked: { entry: ArtistEntry; rank: number; roleCount: number; total: number }[] = []

  for (const entry of directory.values()) {
    if (exclude.has(entry.name)) continue
    const name = entry.name.toLowerCase()
    const sort = entry.sort.toLowerCase()
    let rank: number
    if (!q) rank = 0
    else if (name.startsWith(q)) rank = 0
    else if (name.includes(q)) rank = 1
    else if (sort.startsWith(q)) rank = 2
    else if (sort.includes(q)) rank = 3
    else continue
    const total = Object.values(entry.roles).reduce((sum, count) => sum + (count ?? 0), 0)
    ranked.push({ entry, rank, roleCount: entry.roles[role] ?? 0, total })
  }

  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(b.roleCount > 0) - Number(a.roleCount > 0) ||
      b.total - a.total ||
      a.entry.name.localeCompare(b.entry.name),
  )
  return ranked.slice(0, limit).map(item => item.entry)
}
